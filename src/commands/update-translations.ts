import path from 'path';
import fs from 'fs-extra';
import fg from 'fast-glob';
import {OpenAI} from 'openai';
import chalk from 'chalk';
import difference from 'lodash.difference';
import set from 'lodash.set';

type JSONContent = Record<string, any>;
type FlatJson = Record<string, string>;
type MissingTranslations = Record<string, Record<string, string>>;

const flattenObject = (obj: JSONContent, prefix = ''): FlatJson =>
    Object.entries(obj).reduce((acc, [key, val]) => {
        const newKey = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'object' && val !== null) {
            return {...acc, ...flattenObject(val, newKey)};
        }
        acc[newKey] = val;
        return acc;
    }, {} as FlatJson);

const unflattenObject = (flat: FlatJson): JSONContent =>
    Object.entries(flat).reduce((acc, [key, val]) => {
        set(acc, key, val);
        return acc;
    }, {} as JSONContent);

const isLocale = (name: string) => name.match(/^[A-Za-z]{2,4}([_-][A-Za-z]{4})?([_-]([A-Za-z]{2}|[0-9]{3}))?$/)

const getMissingTranslationsForLocale = async (
    referenceFolder: string,
    localeFolder: string
): Promise<Record<string, string>> => {
    const files = await fg.glob(`${referenceFolder}/**/*.json`);
    const entryGroups = await Promise.all(
        files.map(async (refFilePath) => {
            const relativePath = path.relative(referenceFolder, refFilePath);
            const refJson = await fs.readJson(refFilePath);
            const refFlat = flattenObject(refJson);

            const targetFilePath = path.join(localeFolder, relativePath);
            const exists = await fs.pathExists(targetFilePath);
            const targetJson = exists ? await fs.readJson(targetFilePath) : {};
            const targetFlat = flattenObject(targetJson);

            const missingKeys = difference(Object.keys(refFlat), Object.keys(targetFlat));

            return missingKeys.map((key) => [`${relativePath}:::${key}`, refFlat[key]]);
        })
    );

    return Object.fromEntries(entryGroups.flat());
};

const getAllMissingTranslations = async (
    folderPath: string,
    referenceLocale: string
): Promise<Record<string, Record<string, string>>> => {
    const entries = await fs.readdir(folderPath);
    const locales = entries.filter(isLocale);
    const referenceFolder = path.join(folderPath, referenceLocale);
    const referenceFiles = await fg.glob(`${referenceFolder}/**/*.json`);
    // Get all the keys of all the files contains in the reference locale's folder
    const referenceFlat = (await Promise.all(referenceFiles.map(async (filePath) => {
        const json = await fs.readJson(filePath);
        return flattenObject(json);
    }))).reduce((acc, obj) => ({...acc, ...obj}), {});

    const result: Record<string, Record<string, string>> = {};

    await Promise.all(locales.map(async (locale) => {
        if (locale === referenceLocale) return;

        const localePath = path.join(folderPath, locale);
        const missing = await getMissingTranslationsForLocale(referenceFolder, localePath);
        result[locale] = missing;
    }));

    return result;
};

const translateWithGPT = async (
    sourceTexts: Record<string, string>,
    targetLocale: string
): Promise<Record<string, string>> => {
    const formatted = Object.entries(sourceTexts)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');

    const prompt = `Traduis le contenu suivant dans la locale "${targetLocale}" sans changer les clés.
        Les clés correspondent à <fichierD'origine>:::<la.cle.dans.le.json>: <Le contenu à traduire>\n\n
        ${formatted}`;

    const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});
    const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{role: 'user', content: prompt}],
    });

    const response = completion.choices[0]?.message?.content || '';
    const result: Record<string, string> = {};

    response.split('\n').forEach(line => {
        const [key, ...valParts] = line.split(':');
        if (key && valParts.length) {
            result[key.trim()] = valParts.join(':').trim();
        }
    });

    return result;
};

export const translateMissingKeys = async (
    folderPath: string,
    referenceLocale: string,
    dryRun = false
) => {
    const allMissing = await getAllMissingTranslations(folderPath, referenceLocale);

    await Promise.all(Object.entries(allMissing).map(async ([locale, entries]) => {
        const total = Object.keys(entries).length;
        if (total === 0) {
            console.log(chalk.gray(`✅ ${locale} — rien à traduire.`));
            return;
        }

        if (dryRun) {
            console.log(chalk.yellow(`--- [DRY-RUN] Clés manquantes pour ${locale}`));
            console.log(JSON.stringify(entries, null, 2));
            return;
        }

        console.log(chalk.blue(`🌍 Traduction de ${total} clés pour ${locale}...`));
        const translated = await translateWithGPT(entries, locale);

        await Promise.all(Object.entries(translated).map(async ([fullKey, translatedValue]) => {
            const [relativePath, jsonKey] = fullKey.split(':::');
            const targetPath = path.join(folderPath, locale, relativePath);
            const exists = await fs.pathExists(targetPath);
            const json = exists ? await fs.readJson(targetPath) : {};
            const flat = flattenObject(json);
            flat[jsonKey] = translatedValue;
            const updated = unflattenObject(flat);
            await fs.ensureDir(path.dirname(targetPath));
            await fs.writeJson(targetPath, updated, {spaces: 2});
        }));

        console.log(chalk.green(`✅ ${locale} mis à jour avec ${total} traductions.`));
    }));
};