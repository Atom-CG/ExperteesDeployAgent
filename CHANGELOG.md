# Change Log

All notable changes to the "experdeploy" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.1.2] - 2026-07-16

### Fixed
- **Assets 404 après push** : ajout automatique de la configuration de chemins relatifs sur les 3 frameworks — `base: './'` dans `vite.config.ts` (Vue/React) et `baseHref: './'` dans `angular.json` (Angular). Sans ce paramètre, les bundlers génèrent des chemins absolus dans `index.html` (`/assets/index-XXX.css`) qui ne résolvent pas sur le CDN Power Platform User Content — l'app affichait un écran cassé avec des 404 sur tous les assets, alors même que `power-apps push` retournait "successfully". Appliqué en prévention lors du scaffold ET en auto-réparation avant chaque `push` sur les projets existants.

## [1.1.1] - 2026-07-16

### Fixed
- Correction des 14 warnings ESLint `curly` (accolades manquantes sur `if`/`else` mono-ligne) et suppression d'une directive `eslint-disable` inutilisée.
- Mise à jour des actions du workflow de release (`checkout`, `setup-node`, `action-gh-release`) vers leurs versions majeures actuelles — élimine la notice de dépréciation Node 20 dans les logs CI.

## [1.1.0] - 2026-07-16

### Added
- Connexions Power Platform sauvegardables dans le projet (`.experdeploy.json`) : associez un alias (compte pac + environnement) et rebasculez dessus en une saisie depuis le menu `connexion`. Suppression via `del <alias>`.
- Auto-réparation `TS5101` (`baseUrl` déprécié) lors du `push` : détection dans la sortie de build, patch automatique de `tsconfig.app.json`/`tsconfig.json` (`ignoreDeprecations`), nouvelle tentative de compilation.
- `run` : le proxy Power Apps attend désormais que le port du serveur local réponde (polling TCP, 30s max) avant de démarrer, dans un terminal dédié séparé du serveur de développement.

### Changed
- Authentification `pac auth create` : passage du device code flow (`--deviceCode`) au flow interactif (popup navigateur/WAM) pour l'ajout de compte et l'initialisation Code App. Fallback device code documenté en cas d'échec (environnement corporate, WSL, session distante).
- `run` : retrait du `pac auth create --deviceCode` systématique à chaque lancement (polluait `pac auth list`), remplacé par `pac env select` pour aligner le contexte.
- Scaffold Vue/React : injection de `"ignoreDeprecations": "6.0"` dans les tsconfig patchés, en prévention de `TS5101`.
- Retrait des mentions "Expertime" dans les messages affichés (stack technique).
- Ajout d'un rappel explicite (surveillance terminal / prompts de confirmation) juste avant le lancement du scaffold d'un projet front-end.

### Fixed
- Correction d'une erreur de syntaxe bloquant la compilation (`}` manquante en fin de fichier).
- `threadId` de session correctement résolu par conversation Copilot Chat (l'ancienne implémentation partageait la même session entre toutes les conversations ouvertes).

### Removed
- Suppression du code mort export/import de solutions Dataverse (états `EXPORT_*`/`IMPORT_*`), inatteignable depuis le menu principal.

### Internal
- Factorisation des accès à `power.config.json` et des fonctions d'exécution de script terminal.
- Compression des blocs d'affichage Markdown répétitifs.

## [Unreleased]

- Initial release