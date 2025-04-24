import { Command } from 'commander';
import { translateMissingKeys } from './commands/update-translations.ts';

const program = new Command();

program
    .name('mon-cli')
    .description('CLI pour la traduction des fichiers de locales')
    .version('1.0.0');

program
    .command('update-translations')
    .description('Complète les traductions manquantes dans les fichiers JSON')
    .argument('<folder>', 'Chemin vers le dossier de locales')
    .argument('<referenceLocale>', 'Code de la locale de référence (ex: fr)')
    .option('--dry-run', 'Affiche les clés manquantes sans faire de traduction')
    .action(async (folder, referenceLocale, options) => {
        await translateMissingKeys(folder, referenceLocale, options.dryRun);
    });

program.parse();