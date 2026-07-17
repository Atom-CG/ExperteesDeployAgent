# 🚀 ExperteesDeploy

[![Version](https://img.shields.io/badge/version-1.0.9-blue)](https://github.com/Atom-CG/ExperteesDeployAgent/releases/latest)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.124.0-007ACC)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![AI Credits](https://img.shields.io/badge/Copilot%20AI%20Credits-0%20consommé-brightgreen)](#-zéro-consommation-copilot--compatible-gouvernance-ia)

**Chat Participant GitHub Copilot** pour VS Code qui automatise le cycle de vie des projets **Power Apps Code App** (Code First).

Une machine d'état conversationnelle pilote le terminal VS Code et vous guide via un menu numéroté : scaffolding, initialisation Code App, inner-loop (`run` / `push`), gestion des connexions `pac`. L'objectif : supprimer les erreurs de manipulation sur les phases critiques (authentification, ports, `appId` obsolète).

---

## 💚 Zéro consommation Copilot — compatible gouvernance IA

**ExperteesDeploy n'appelle aucun modèle de langage.** L'extension utilise l'interface Copilot Chat comme **frontend conversationnel**, mais tout le traitement est **déterministe** (machine d'état + scripts PowerShell). Concrètement :

| Ressource | Consommation |
|-----------|--------------|
| Tokens / AI Credits GitHub Copilot | **0** |
| Requêtes Copilot Chat (rate-limit) | **0** |
| Appels API vers un LLM (OpenAI, Anthropic, Azure OpenAI…) | **0** |
| Données envoyées à un service IA externe | **aucune** |

### Ce que ça implique

- ✅ **Compatible avec les politiques DLP / gouvernance IA** les plus strictes — aucun traitement IA à documenter côté client
- ✅ **Aucun impact** sur votre quota mensuel d'AI Credits Copilot (nouveau modèle de facturation à la consommation en vigueur depuis le 1er juin 2026)
- ✅ **Utilisable avec Copilot Free** — pas besoin d'un plan Pro/Business pour faire tourner l'agent
- ⚠️ **Prérequis** : GitHub Copilot Chat doit être installé et activé pour que l'API `chatParticipant` soit disponible (mais aucun appel modèle n'est effectué)

> Techniquement : le handler du participant lit le texte brut de l'utilisateur (`request.prompt`), le route dans une `switch` sur l'état courant, et répond via `stream.markdown()` avec des templates statiques. Aucun `vscode.lm.sendChatRequest()` ni équivalent n'est présent dans le code.

---

## 📋 Prérequis

| Prérequis | Version | Notes |
|-----------|---------|-------|
| VS Code | ≥ 1.124.0 | |
| GitHub Copilot Chat | — | requis pour l'API Chat Participant (**aucune conso de tokens**) |
| Node.js | ≥ 20 LTS | |
| Git | — | |
| Power Platform CLI (`pac`) | à jour | via l'extension *Power Platform Tools* ou `dotnet tool install` |
| **PowerShell** | 5.1 / 7.x | ⚠️ terminal par défaut requis — les scripts générés sont du PowerShell |

> **Licence Power Platform** : les Code Apps nécessitent un environnement Dataverse et, selon les connecteurs consommés, des licences **Premium** (Per App / Per User). L'agent n'ajoute aucune exigence de licence supplémentaire.

L'agent vérifie et installe automatiquement les extensions manquantes (`github.copilot-chat`, `microsoft-IsvExpTools.powerplatform-vscode`) via l'option **`prérequis`**.

---

## 📦 Installation

Téléchargez le `.vsix` de la dernière release et installez-le. Bloc **PowerShell** segmenté (contourne les bugs de copie d'URL de l'interface GitHub) :

```powershell
$domain = "github.com"
$path = "Atom-CG/ExperteesDeployAgent/releases/latest/download/experdeploy.vsix"
Invoke-WebRequest -Uri "https://$domain/$path" -OutFile "$env:TEMP\experdeploy.vsix"
code --install-extension "$env:TEMP\experdeploy.vsix" --force
Remove-Item "$env:TEMP\experdeploy.vsix"
```

Rechargez ensuite VS Code (`Ctrl+Shift+P` → **Developer: Reload Window**).

> 💡 Les mises à jour ultérieures se font directement depuis l'agent avec l'option **`6` / `maj`**.

---

## 🎯 Utilisation

Ouvrez **Copilot Chat** et invoquez l'agent :

```
@Expertees-Deploy
```

Le menu principal s'affiche. Répondez avec le **numéro** ou le **mot-clé** de l'action.

| # | Mot-clé | Action |
|---|---------|--------|
| **1** | `init` | Scaffolder un projet front-end (Vue · React · Angular) avec la stack Expertime |
| **2** | `codeapp` | Transformer le projet courant en Power Apps Code App |
| **3** | `run` | Démarrer le serveur de dev (inner-loop, connexion maintenue) |
| **4** | `push` | Compiler et pousser le Code App vers Dataverse |
| **5** | `connexion` | Gérer les profils `pac` et sélectionner l'environnement |
| **6** | `maj` | Mettre à jour l'extension vers la dernière release |

Tapez `menu` (ou `reset`) à tout moment pour revenir au menu principal.

> 🧠 **Aucun modèle IA n'est sollicité** lorsque vous interagissez avec l'agent — vos messages ne sortent pas de votre poste, ils sont uniquement matchés contre les mots-clés du menu.

---

### 1 · `init` — Scaffolding

Crée un projet front-end complet, sans prompt interactif bloquant (`create-vite` est exécuté sans TTY, puis patché automatiquement : alias `@/*`, plugin Tailwind v4, directive CSS).

| Framework | Stack générée |
|-----------|---------------|
| **Vue** *(défaut)* | Vue 3.5 + Vite 7 + Pinia + vue-router 5 + Tailwind CSS v4 + shadcn-vue (Vega) |
| **React** | React 19 + Vite 7 + React Router v7 + Zustand + Tailwind CSS v4 + shadcn/ui |
| **Angular** | Angular 19 + Router + NgRx Signals + Tailwind CSS v4 |

**Raccourci** — court-circuite le choix framework + nom :

```
@Expertees-Deploy init vue mon-projet
```

> ⚠️ Si un workspace est déjà ouvert, le scaffolding se fait **dans le dossier courant** et `create-vite --overwrite` **supprime les fichiers existants** (hors `.git`). Lancez-le sur un dossier vide ou un projet versionné.

---

### 2 · `codeapp` — Initialisation Code App

Sous-menu :

- **`1` / `prérequis`** — audite Node.js, Git, le SDK `@microsoft/power-apps` et les extensions VS Code, puis propose l'installation automatique de ce qui manque.
- **`2` / `initialiser`** — demande l'**ID d'environnement**, puis enchaîne dans le terminal :

```powershell
pac auth create --environment <envId> --deviceCode
npm install @microsoft/power-apps
npx power-apps init
```

L'ID du dernier environnement utilisé (menu `connexion`) est proposé par défaut.

> 🔐 **Auto-réparation `AADSTS70043`** : `power-apps init` gère son **propre** cache MSAL, distinct de celui de `pac`. Un `pac auth create` réussi ne le rafraîchit **pas**. En cas d'échec, l'agent enchaîne automatiquement `npx power-apps logout` (commande officielle) → `pac auth create` → nouvelle tentative de `init`.

---

### 3 · `run` — Inner-loop local

1. Détecte le framework et son port de dev (`vite.config.*` en priorité, sinon déduction depuis `package.json` : Vite 5173, Angular 4200, CRA/Next 3000).
2. Met à jour `localAppUrl` dans `power.config.json`.
3. Rafraîchit la connexion `pac` avec l'`environmentId` déjà présent dans `power.config.json` (**sans redemander l'ID**).
4. Lance `npm run dev`.
5. Ouvre le navigateur sur l'URL `apps.powerapps.com/play/e/<env>/app/local?...`.

> ℹ️ Le message *"NOT currently running"* au démarrage est **normal** (quelques secondes de latence). S'il persiste > 30 s, vérifiez que votre config expose bien le bon port :
> ```ts
> export default { server: { port: 5173 } }
> ```

> ⚠️ On lance **uniquement** `npm run dev` : le script `dev` généré par `power-apps init` démarre **déjà** le proxy Power Apps *et* Vite. Ajouter `npx power-apps run` en parallèle est redondant et relance un flow d'auth CLI séparé.

---

### 4 · `push` — Déploiement vers Dataverse

Demande une confirmation (`oui` / `non`), puis exécute :

```powershell
npm run build      # génération du dossier dist
npx power-apps push  # envoi vers Dataverse
```

**Gestion d'erreurs intégrée** :

| Symptôme détecté | Traitement automatique |
|------------------|------------------------|
| Échec `npm run build` | Arrêt immédiat, message explicite (corriger TypeScript/Vite avant de retenter) |
| `ApplicationNotFound` / *could not be found* | L'`appId` obsolète est **supprimé de `power.config.json`**, puis le push est **relancé** automatiquement |
| `Unauthorized` / `401` | Message invitant à relancer `pac auth create --environment <ID> --deviceCode` |
| Autre | Sortie brute du CLI affichée dans le terminal |

> 💡 Le cas `ApplicationNotFound` arrive typiquement quand la Code App a été supprimée côté environnement, ou quand `power.config.json` a été copié depuis un autre environnement — d'où la purge de l'`appId` plutôt qu'une édition manuelle.

---

### 5 · `connexion` — Profils & environnements

| Saisie | Action |
|--------|--------|
| `N°` | Sélectionner le profil `pac` correspondant (`pac auth select --index N`) |
| `0` | Ajouter un compte (`pac auth create --deviceCode`, authentification MFA navigateur) → tapez `suite` une fois terminé |
| `menu` | Retour |

L'agent liste ensuite les environnements (`pac env list`) ; saisissez l'**URL** ou l'**ID**. La sélection est appliquée (`pac env select`) et **persistée** dans `power.config.json` (champ `selectedEnvironment`) pour être réutilisée par `codeapp`.

---

## 🗂️ Champs `power.config.json` utilisés

| Champ | Écrit par | Rôle |
|-------|-----------|------|
| `environmentId` | `power-apps init` | Rafraîchissement `pac` silencieux avant `run` |
| `selectedEnvironment` | **ExperteesDeploy** (`connexion`) | Environnement proposé par défaut à l'initialisation |
| `localAppUrl` | **ExperteesDeploy** (`run`) | Port du serveur de dev détecté |
| `appId` | `power-apps push` | Supprimé automatiquement si obsolète |

---

## 🔒 Confidentialité & sécurité

- **Aucune télémétrie** émise par l'extension.
- **Aucune donnée** (code, `power.config.json`, credentials `pac`) n'est envoyée hors de votre poste.
- Les authentifications utilisent les flows **officiels Microsoft** (`pac auth create`, `power-apps init`) — aucun secret n'est stocké par l'extension elle-même.
- Le code source est **auditable** ([`src/extension.ts`](./src/extension.ts)) — mono-fichier, ~1800 lignes, sans dépendance runtime.

---

## 🛠️ Développement

```bash
git clone https://github.com/Atom-CG/ExperteesDeployAgent.git
cd ExperteesDeployAgent
npm install
```

| Script | Rôle |
|--------|------|
| `npm run watch` | Build webpack en watch (puis `F5` pour lancer l'Extension Host) |
| `npm run compile` | Build unique |
| `npm run package` | Build production (`--devtool hidden-source-map`) |
| `npm run lint` | ESLint sur `src` |
| `npm test` | Tests via `vscode-test` |
| `npm run package-vsix` | Génère `experdeploy.vsix` |

**Architecture** — extension mono-fichier (`src/extension.ts`) :

- Machine d'état `EtatConversation` + `Map<threadId, SessionALM>`
- `gererRequete` : dispatch `switch` sur l'état courant (**purement déterministe, aucun appel LLM**)
- Helpers terminal : `executerDansTerminal`, `executerScriptSecurise` (arrêt à la 1ʳᵉ erreur), `executerScriptSecuriseAvecBilan` (+ journal des erreurs et bilan final)
- Helpers `power.config.json` : lecture/écriture des champs ci-dessus

> ⚠️ Toutes les commandes sont envoyées via `terminal.sendText()` — équivalent à une saisie manuelle. L'API *Shell Integration* a été retirée (blocages indéfinis constatés, y compris sur un simple `Write-Host`). Les scripts PowerShell générés doivent donc être **auto-suffisants** et ne dépendre d'aucun événement VS Code.

---

## 🐛 Dépannage

| Problème | Piste |
|----------|-------|
| L'agent n'apparaît pas dans Copilot Chat | Copilot Chat installé et connecté ? Reload Window après installation du `.vsix` |
| Erreurs de syntaxe dans le terminal | Le terminal par défaut doit être **PowerShell**, pas cmd/bash |
| `AADSTS70043` sur `power-apps init` | Conditional Access : géré automatiquement (`power-apps logout` + réauth). Sinon `npx power-apps logout` manuel |
| `pac` introuvable | Installer *Power Platform Tools*, puis rouvrir le terminal |
| Le navigateur s'ouvre sur une page blanche | `localAppUrl` / port : vérifier `server.port` dans `vite.config.ts` |

---

## 📄 Licence

MIT — voir [LICENSE](./LICENSE).

Développé par **Atom-CG** · [Issues](https://github.com/Atom-CG/ExperteesDeployAgent/issues)