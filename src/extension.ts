import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// TYPES & CONSTANTES
// ---------------------------------------------------------------------------

type EtatConversation =
  | "MENU_PRINCIPAL"
  | "INIT_CHOIX_FRAMEWORK"
  | "INIT_NOM_PROJET"
  | "EXPORT_NOM_SOLUTION"
  | "EXPORT_ID_SOURCE"
  | "IMPORT_NOM_SOLUTION"
  | "IMPORT_ID_CIBLE"
  | "CODE_APP_MENU"
  | "CODE_APP_PREREQ_INSTALL"
  | "CODE_APP_INIT_CONFIRM"
  | "CODE_APP_INIT_ENV"
  | "CODE_APP_PUSH_CONFIRM"
  | "CONNEXION_CHOIX_COMPTE"
  | "CONNEXION_AJOUT_COMPTE"
  | "CONNEXION_CHOIX_ENV";

interface SessionALM {
  etat: EtatConversation;
  nomProjet: string;
  frameworkChoisi: string;
  nomSolution: string;
  idSource: string;
  idCible: string;
  codeAppManquants: string[];
  compteIndex: number;
  environnementSelectionne: string;
}

const NOM_TERMINAL = "Power ALM ExperteesDeploy";
const sessions = new Map<string, SessionALM>();

function obtenirOuCreerSession(threadId: string): SessionALM {
  if (!sessions.has(threadId)) {
    sessions.set(threadId, {
      etat: "MENU_PRINCIPAL",
      nomProjet: "",
      frameworkChoisi: "",
      nomSolution: "",
      idSource: "",
      idCible: "",
      codeAppManquants: [],
      compteIndex: 0,
      environnementSelectionne: "",
    });
  }
  return sessions.get(threadId)!;
}

function reinitialiserSession(threadId: string): void {
  const session = obtenirOuCreerSession(threadId);
  session.etat = "MENU_PRINCIPAL";
}

// ---------------------------------------------------------------------------
// UTILITAIRES TERMINAL
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LECTURE DE L'URL DU SERVEUR DEPUIS power.config.json
// ---------------------------------------------------------------------------

function lireUrlServeur(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  const configPath = path.join(
    workspaceFolders[0].uri.fsPath,
    "power.config.json",
  );
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    // URL directe stockée dans le fichier
    if (typeof config.playUrl === "string") {
      return config.playUrl;
    }
    if (typeof config.url === "string") {
      return config.url;
    }
    if (typeof config.serverUrl === "string") {
      return config.serverUrl;
    }

    // Construction depuis environmentId + ports (format Power Apps Code App)
    const environmentId = config.environmentId ?? config.environment_id;
    if (typeof environmentId === "string") {
      const connectionsPort: number =
        config.server?.port ?? config.port ?? 8080;
      // Préférer localAppUrl (mis à jour automatiquement à chaque run)
      let devPort: number = config.devPort ?? config.dev?.port ?? 3000;
      if (typeof config.localAppUrl === "string") {
        const m = config.localAppUrl.match(/:([0-9]+)/);
        if (m) {
          devPort = parseInt(m[1], 10);
        }
      }
      return (
        `https://apps.powerapps.com/play/e/${environmentId}/app/local` +
        `?_localAppUrl=http://localhost:${devPort}` +
        `&_localConnectionUrl=http://localhost:${connectionsPort}`
      );
    }

    // Fallback : port seul
    if (config.server) {
      if (typeof config.server.url === "string") {
        return config.server.url;
      }
      if (
        typeof config.server.port === "number" ||
        typeof config.server.port === "string"
      ) {
        return `http://localhost:${config.server.port}`;
      }
    }
    if (typeof config.port === "number" || typeof config.port === "string") {
      return `http://localhost:${config.port}`;
    }
  } catch {
    // JSON invalide ou lecture impossible
  }
  return undefined;
}

// Détecte le port du serveur de développement selon le framework du projet
function detecterPortDevServeur(): { port: number; framework: string } {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return { port: 3000, framework: "inconnu" };
  }

  const racine = workspaceFolders[0].uri.fsPath;

  // 1. Port explicite dans vite.config.* (priorité maximale)
  for (const nom of [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
    "vite.config.mjs",
  ]) {
    const vitePath = path.join(racine, nom);
    if (fs.existsSync(vitePath)) {
      try {
        const contenu = fs.readFileSync(vitePath, "utf-8");
        const match = contenu.match(/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s);
        if (match) {
          return {
            port: parseInt(match[1], 10),
            framework: "Vite (port personnalisé)",
          };
        }
      } catch {
        /* ignore */
      }
      // Vite présent sans port explicite → défaut Vite = 5173
      return { port: 5173, framework: "Vite" };
    }
  }

  // 2. Détection via package.json
  const pkgPath = path.join(racine, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps["vue"] && (deps["vite"] || deps["@vitejs/plugin-vue"])) {
        return { port: 5173, framework: "Vue + Vite" };
      }
      if (deps["react"] && (deps["vite"] || deps["@vitejs/plugin-react"])) {
        return { port: 5173, framework: "React + Vite" };
      }
      if (deps["vite"]) {
        return { port: 5173, framework: "Vite" };
      }
      if (deps["react-scripts"]) {
        return { port: 3000, framework: "React (CRA)" };
      }
      if (deps["@angular/core"]) {
        return { port: 4200, framework: "Angular" };
      }
      if (deps["next"]) {
        return { port: 3000, framework: "Next.js" };
      }
    } catch {
      /* ignore */
    }
  }

  return { port: 3000, framework: "inconnu" };
}

// Met à jour le champ localAppUrl dans power.config.json
function mettreAJourLocalAppUrl(port: number): boolean {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return false;
  }

  const configPath = path.join(
    workspaceFolders[0].uri.fsPath,
    "power.config.json",
  );
  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    config.localAppUrl = `http://localhost:${port}`;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function ouvrirNavigateurServeur(
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const DELAI_DEMARRAGE_MS = 3000;
  await new Promise((resolve) => setTimeout(resolve, DELAI_DEMARRAGE_MS));

  const url = lireUrlServeur();
  if (!url) {
    stream.markdown(
      "> ⚠️ Impossible de trouver l'URL du serveur dans `power.config.json`.\n",
    );
    return;
  }

  const uri = vscode.Uri.parse(url);
  await vscode.env.openExternal(uri);
  stream.markdown(`> 🌐 Navigateur ouvert sur **${url}**\n`);
}

// ---------------------------------------------------------------------------
// GESTION DE L'ENVIRONNEMENT SÉLECTIONNÉ
// ---------------------------------------------------------------------------

function sauvegarderEnvironnementDansConfig(envUrl: string): boolean {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return false;
  }

  const configPath = path.join(
    workspaceFolders[0].uri.fsPath,
    "power.config.json",
  );
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      /* démarrer avec un objet vide */
    }
  }

  config.selectedEnvironment = envUrl;
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// UTILITAIRES TERMINAL
// ---------------------------------------------------------------------------

function obtenirOuCreerTerminal(): vscode.Terminal {
  const existant = vscode.window.terminals.find((t) => t.name === NOM_TERMINAL);
  if (existant) return existant;

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const cwd =
    workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : undefined;

  return vscode.window.createTerminal({ name: NOM_TERMINAL, cwd: cwd });
}

function executerDansTerminal(commande: string): void {
  const terminal = obtenirOuCreerTerminal();
  terminal.show(true);
  terminal.sendText(commande);
}

function executerScriptSecurise(commandes: string[]): void {
  const terminal = obtenirOuCreerTerminal();
  terminal.show(true);

  for (const cmd of commandes) {
    const commandeSecurisee = `${cmd}; if ($LASTEXITCODE -ne 0) { Write-Host '❌ Arrêt du script suite à une erreur.' -ForegroundColor Red; break }`;
    terminal.sendText(commandeSecurisee);
  }
}

// ---------------------------------------------------------------------------
// POWER APPS CODE APP — PRÉREQUIS ET INITIALISATION
// ---------------------------------------------------------------------------

function afficherMenuCodeApp(stream: vscode.ChatResponseStream): void {
  stream.markdown("## 📱 **Power Apps Code App**\n\n");
  stream.markdown(
    "> Configurez votre projet actuel pour le connecter à Power Apps Code First.\n\n",
  );
  stream.markdown("---\n\n");
  stream.markdown("| # | Action | Description |\n");
  stream.markdown("|---|--------|-------------|\n");
  stream.markdown(
    "| **1** | `prérequis` | Vérifier et installer les prérequis |\n",
  );
  stream.markdown(
    "| **2** | `initialiser` | Initialiser directement le projet |\n\n",
  );
  stream.markdown("> Tapez **menu** pour revenir au menu principal.\n");
}

async function verifierPrerequisCodeApp(
  stream: vscode.ChatResponseStream,
  session: SessionALM,
): Promise<void> {
  const manquants: string[] = [];

  stream.markdown("## 🔍 Analyse des prérequis...\n\n");

  // Vérification des extensions VS Code
  stream.markdown("### 🧩 Extensions VS Code\n\n");

  const copilot = vscode.extensions.getExtension("github.copilot-chat");
  if (copilot) {
    stream.markdown("✅ **GitHub Copilot Chat** — installée\n\n");
  } else {
    stream.markdown("❌ **GitHub Copilot Chat** — non installée\n\n");
    manquants.push("ext:github.copilot-chat");
  }

  const ppTools = vscode.extensions.getExtension(
    "microsoft-IsvExpTools.powerplatform-vscode",
  );
  if (ppTools) {
    stream.markdown("✅ **Power Platform Tools** — installée\n\n");
  } else {
    stream.markdown("❌ **Power Platform Tools** — non installée\n\n");
    manquants.push("ext:microsoft-IsvExpTools.powerplatform-vscode");
  }

  // Vérification système dans le terminal
  stream.markdown("### 💻 Environnement système\n\n");
  stream.markdown(
    "> _Un script de vérification est lancé dans le terminal. Consultez-le pour les résultats._\n\n",
  );

  const scriptVerif = [
    `Write-Host "╔══════════════════════════════╗" -ForegroundColor Cyan`,
    `Write-Host "║  Vérification des prérequis  ║" -ForegroundColor Cyan`,
    `Write-Host "╚══════════════════════════════╝" -ForegroundColor Cyan`,
    `$nv = node --version 2>&1; if ($LASTEXITCODE -eq 0) { Write-Host "✅ Node.js : $nv" -ForegroundColor Green } else { Write-Host "❌ Node.js : non trouvé — installez depuis https://nodejs.org" -ForegroundColor Red }`,
    `$gv = git --version 2>&1; if ($LASTEXITCODE -eq 0) { Write-Host "✅ Git : $gv" -ForegroundColor Green } else { Write-Host "❌ Git : non trouvé — installez depuis https://git-scm.com" -ForegroundColor Red }`,
    `$pkg = npm list @microsoft/power-apps 2>&1; if ($LASTEXITCODE -eq 0) { Write-Host "✅ @microsoft/power-apps : installé" -ForegroundColor Green } else { Write-Host "⚠️  @microsoft/power-apps : non trouvé (sera installé lors de l'initialisation)" -ForegroundColor Yellow }`,
  ];

  const terminal = obtenirOuCreerTerminal();
  terminal.show(true);
  for (const cmd of scriptVerif) {
    terminal.sendText(cmd);
  }

  session.codeAppManquants = manquants;
}

async function installerPrerequisCodeApp(
  stream: vscode.ChatResponseStream,
  session: SessionALM,
): Promise<void> {
  stream.markdown("## ⚙️ Installation des prérequis manquants...\n\n");

  // Installation des extensions VS Code manquantes
  for (const item of session.codeAppManquants) {
    if (item.startsWith("ext:")) {
      const extId = item.replace("ext:", "");
      stream.markdown(`🔌 Installation de l'extension **${extId}**...\n\n`);
      try {
        await vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          extId,
        );
        stream.markdown(`✅ Extension installée avec succès.\n\n`);
      } catch {
        stream.markdown(
          `⚠️ Impossible d'installer **${extId}** automatiquement. Installez-la via le Marketplace VS Code.\n\n`,
        );
      }
    }
  }

  // Installation du SDK npm
  stream.markdown(
    "📦 Installation du SDK **@microsoft/power-apps** dans le terminal...\n\n",
  );
  executerDansTerminal("npm install @microsoft/power-apps");
}

// ---------------------------------------------------------------------------
// GESTIONNAIRE DE RÉPONSE DE L'AGENT
// ---------------------------------------------------------------------------

async function gererRequete(
  requete: vscode.ChatRequest,
  contexte: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  _jeton: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  let threadId: string;
  if (contexte.history.length > 0) {
    const newId = String(contexte.history[0]);
    if (!sessions.has(newId) && sessions.has("thread_default")) {
      sessions.set(newId, sessions.get("thread_default")!);
      sessions.delete("thread_default");
    }
    threadId = newId;
  } else {
    threadId = "thread_default";
  }
  const session = obtenirOuCreerSession(threadId);
  const messageUtilisateur = requete.prompt.trim();
  const messageNormalise = messageUtilisateur.toLowerCase();

  switch (session.etat) {
    case "MENU_PRINCIPAL": {
      if (
        !messageUtilisateur ||
        messageNormalise === "menu" ||
        messageNormalise === "reset"
      ) {
        afficherMenuPrincipal(stream);
        break;
      }

      if (messageNormalise === "1" || messageNormalise === "init") {
        session.etat = "INIT_CHOIX_FRAMEWORK";
        stream.markdown("## 🏗️ Initialisation d'un nouveau projet\n\n");
        stream.markdown("### Stack technique Expertime — Vue (par défaut)\n\n");
        stream.markdown("| Couche | Technologie |\n");
        stream.markdown("|--------|-------------|\n");
        stream.markdown(
          '| **Framework** | Vue 3.5 (`<script setup lang="ts">`) |\n',
        );
        stream.markdown("| **Build** | Vite 7 + vue-tsc |\n");
        stream.markdown("| **État** | Pinia (setup stores) |\n");
        stream.markdown(
          "| **Routing** | vue-router 5 — `createWebHashHistory` |\n",
        );
        stream.markdown("| **UI** | shadcn-vue Vega + Tailwind CSS v4 |\n");
        stream.markdown("| **URLs** | Relatives uniquement |\n\n");
        stream.markdown("---\n\n");
        stream.markdown("**Que souhaitez-vous faire ?**\n\n");
        stream.markdown("| # | Choix |\n");
        stream.markdown("|---|-------|\n");
        stream.markdown("| **1** | Continuer avec Vue (stack par défaut) |\n");
        stream.markdown("| **2** | Utiliser React à la place |\n");
        stream.markdown("| **3** | Utiliser Angular à la place |\n");
        stream.markdown("| **0** | Revenir au menu principal |\n\n");
        break;
      }

      if (messageNormalise === "2" || messageNormalise === "codeapp") {
        session.etat = "CODE_APP_MENU";
        afficherMenuCodeApp(stream);
        break;
      }

      if (messageNormalise === "3" || messageNormalise === "run") {
        const { port: portDev, framework } = detecterPortDevServeur();
        const localAppUrlMisAJour = mettreAJourLocalAppUrl(portDev);

        stream.markdown(
          "▶️ **Lancement du proxy Power Apps et du serveur local...**\n\n",
        );
        if (localAppUrlMisAJour) {
          stream.markdown(
            `> 🔧 Framework détecté : **${framework}** — \`localAppUrl\` mis à jour → \`http://localhost:${portDev}\` dans \`power.config.json\`\n\n`,
          );
        }
        executerDansTerminal("npm run dev & npx power-apps run");
        stream.markdown("> ⏳ Les deux serveurs démarrent en parallèle.\n\n");
        stream.markdown(
          `> ℹ️ L'avertissement _"NOT currently running"_ est **normal** — le serveur (port ${portDev}) prend quelques secondes à démarrer.\n\n`,
        );
        stream.markdown(
          `> ⚠️ **Si le message persiste après 30 secondes**, vérifiez que votre config expose bien le port ${portDev} :\n`,
        );
        stream.markdown(
          `> \`\`\`js\n> export default {\n>   server: { port: ${portDev} }\n> }\n> \`\`\`\n\n`,
        );
        ouvrirNavigateurServeur(stream);
        reinitialiserSession(threadId);
        break;
      }

      if (messageNormalise === "4" || messageNormalise === "push") {
        session.etat = "CODE_APP_PUSH_CONFIRM";
        stream.markdown("## ⬆️ Push du Code App vers Dataverse\n\n");
        stream.markdown(
          "> Cette opération va **compiler le projet** (`npm run build`) puis **pousser le code** vers votre environnement Power Platform via `npx power-apps push`.\n\n",
        );
        stream.markdown("**Confirmez-vous le push ?**\n\n");
        stream.markdown(
          "> Répondez **oui** pour lancer le push, ou **non** pour revenir au menu principal.\n",
        );
        break;
      }

      if (messageNormalise === "5" || messageNormalise === "connexion") {
        session.etat = "CONNEXION_CHOIX_COMPTE";
        stream.markdown("## 🔐 **Gestion de la connexion Power Platform**\n\n");
        stream.markdown(
          "> La liste de vos profils PAC s'affiche dans le terminal ci-dessous.\n\n",
        );
        executerDansTerminal("pac auth list");
        stream.markdown("---\n\n");
        stream.markdown("| Saisie | Action |\n");
        stream.markdown("|--------|--------|\n");
        stream.markdown(
          "| `N°` | Utiliser le compte correspondant (ex : `1`) |\n",
        );
        stream.markdown("| `0` | Ajouter un nouveau compte |\n");
        stream.markdown("| `menu` | Revenir au menu principal |\n\n");
        stream.markdown(
          "> ⬆️ Consultez le terminal pour voir vos comptes disponibles, puis répondez ici.\n",
        );
        break;
      }

      stream.markdown("❓ Choix non reconnu.\n\n");
      afficherMenuPrincipal(stream);
      break;
    }

    // --- PHASE INIT PROJET : CHOIX DU FRAMEWORK ---
    case "INIT_CHOIX_FRAMEWORK": {
      if (!messageUtilisateur) break;

      if (
        messageNormalise === "0" ||
        messageNormalise === "menu" ||
        messageNormalise === "retour"
      ) {
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      if (
        messageNormalise === "1" ||
        messageNormalise === "vue" ||
        messageNormalise === "continuer"
      ) {
        session.frameworkChoisi = "vue";
      } else if (messageNormalise === "2" || messageNormalise === "react") {
        session.frameworkChoisi = "react";
      } else if (messageNormalise === "3" || messageNormalise === "angular") {
        session.frameworkChoisi = "angular";
      } else {
        stream.markdown(
          "❓ Choix non reconnu. Tapez `1` (Vue), `2` (React), `3` (Angular) ou `0` (menu).\n",
        );
        break;
      }

      const labelsFramework: Record<string, string> = {
        vue: "Vue 3.5",
        react: "React 19",
        angular: "Angular 19",
      };
      stream.markdown(
        `✅ Framework sélectionné : **${labelsFramework[session.frameworkChoisi]}**\n\n`,
      );
      stream.markdown(
        "> ⚠️ **Attention** : l'installation va enchaîner plusieurs commandes dans le terminal. Certaines pourront vous demander une **confirmation/acceptation manuelle** (ex : prompts npm) — surveillez le terminal et validez-les au fur et à mesure.\n\n",
      );
      if (session.frameworkChoisi === "vue") {
        stream.markdown(
          "> ⏹️ **Vue.js** : une fois le scaffolding terminé, un serveur de développement peut se lancer **automatiquement** dans le terminal. Faites **`CTRL+C`** dans le terminal pour l'arrêter afin que la suite de l'installation puisse continuer.\n\n",
        );
      }
      session.etat = "INIT_NOM_PROJET";
      stream.markdown(
        "Quel est le **nom du projet** ?\n> _Ex: mon-projet-pcf_",
      );
      break;
    }

    // --- PHASE INIT PROJET : NOM & SCAFFOLD ---
        case 'INIT_NOM_PROJET': {
            if (!messageUtilisateur) break;
            session.nomProjet = messageUtilisateur.trim();

            const workspaceFolders = vscode.workspace.workspaceFolders;
            const enDansDossier = workspaceFolders && workspaceFolders.length > 0;
            const framework = session.frameworkChoisi || 'vue';

            let commandesInit: string[];
            let descriptionStack: string;

            // 🧠 SCRIPT NODE.JS "MAGIQUE" POUR VITE
            // Exécute create-vite sans TTY (bloque l'assistant) et applique les patchs
            const setupJs = `
const fs = require('fs');
const { execSync } = require('child_process');
const target = process.argv[2] || '.';
const template = process.argv[3] || 'vue-ts';

try {
    console.log('\\n⚡ Initialisation de Vite (mode silencieux strict)...');
    // Le secret est ici : stdio 'ignore' simule l'absence de clavier.
    // Vite ne PEUT PAS poser de questions et ne lancera pas npm run dev.
    // --overwrite : évite que create-vite annule silencieusement ("Operation cancelled")
    // quand le dossier cible n'est pas totalement vide (ex: .git, .vscode déjà présents).
    // --no-interactive : force le mode non-interactif explicitement (ceinture + bretelles avec stdio ignore).
    execSync('npm create vite@latest "' + target + '" --yes -- --template ' + template + ' --overwrite --no-interactive', { 
        stdio: ['ignore', 'inherit', 'inherit'] 
    });

    // Déplacement dans le dossier créé (si applicable) pour modifier les fichiers
    if (target !== '.') {
        process.chdir(target);
    }

    console.log('🔧 Application des patchs Expertime...');
    // shadcn/shadcn-vue lisent les alias de chemin dans le tsconfig.json RACINE (pas seulement
    // tsconfig.app.json) : sans "baseUrl"/"paths" à la racine, l'init échoue avec "Could not load
    // the workspace config ... configure its path aliases". Il faut donc patcher les DEUX fichiers.
    function patchTsconfig(file) {
        if (!fs.existsSync(file)) { return; }
        let ts = fs.readFileSync(file, 'utf8');
        if (ts.includes('"baseUrl"')) { return; }
        if (ts.includes('"compilerOptions": {')) {
            ts = ts.replace('"compilerOptions": {', '"compilerOptions": {\\n    "baseUrl": ".",\\n    "paths": { "@/*": ["./src/*"] },');
        } else {
            // tsconfig.json racine de type "solution" (juste files/references, pas de compilerOptions)
            const idx = ts.indexOf('{');
            ts = ts.slice(0, idx + 1) + '\\n  "compilerOptions": {\\n    "baseUrl": ".",\\n    "paths": { "@/*": ["./src/*"] }\\n  },' + ts.slice(idx + 1);
        }
        fs.writeFileSync(file, ts);
    }
    patchTsconfig('tsconfig.json');
    patchTsconfig('tsconfig.app.json');

    const viteFile = 'vite.config.ts';
    if (fs.existsSync(viteFile)) {
        let vc = fs.readFileSync(viteFile, 'utf8');
        const importsToAdd = [];
        if (!vc.includes('alias')) {
            importsToAdd.push("import path from 'path';");
            vc = vc.replace('plugins: [vue()]', "plugins: [vue()],\\n  resolve: { alias: { '@': path.resolve(__dirname, './src') } }");
            vc = vc.replace('plugins: [react()]', "plugins: [react()],\\n  resolve: { alias: { '@': path.resolve(__dirname, './src') } }");
        }
        // Enregistrement du plugin Tailwind CSS v4 (@tailwindcss/vite) — requis pour que
        // shadcn/shadcn-vue détectent une installation Tailwind valide (voir get-project-info.ts).
        if (!vc.includes('@tailwindcss/vite')) {
            importsToAdd.push("import tailwindcss from '@tailwindcss/vite';");
            vc = vc.replace(/plugins: \\[(vue\\(\\)|react\\(\\))\\]/, 'plugins: [$1, tailwindcss()]');
        }
        if (importsToAdd.length) {
            vc = importsToAdd.join('\\n') + '\\n' + vc;
        }
        fs.writeFileSync(viteFile, vc);
    }

    // Injection de la directive Tailwind CSS v4 dans le fichier CSS d'entrée.
    // shadcn/shadcn-vue exigent un fichier CSS contenant @import "tailwindcss";
    // pour détecter une configuration Tailwind valide, sinon : "No Tailwind CSS configuration found".
    const cssFile = ['src/index.css', 'src/style.css'].find((f) => fs.existsSync(f));
    if (cssFile) {
        let css = fs.readFileSync(cssFile, 'utf8');
        if (!css.includes('@import "tailwindcss"')) {
            css = '@import "tailwindcss";\\n\\n' + css;
            fs.writeFileSync(cssFile, css);
        }
    }

    console.log('✅ Fichiers prêts.\\n');
} catch (e) {
    console.error('❌ Erreur Node:', e.message);
    process.exit(1);
}
            `.trim();
            
            // Encodage Base64 dynamique à la volée
            const setupBase64 = Buffer.from(setupJs).toString('base64');

            // Génération du fichier temporaire .cjs et exécution (avec passage du dossier et du template)
            const prepareAndScaffold = (cible: string, template: string) => [
                `[IO.File]::WriteAllBytes('expertees-setup.cjs', [Convert]::FromBase64String('${setupBase64}'))`,
                `node expertees-setup.cjs "${cible}" "${template}"`,
                `Remove-Item expertees-setup.cjs`
            ];

            if (framework === 'react') {
                descriptionStack = 'React 19 + Vite 7 + React Router v7 + Zustand + Tailwind CSS v4 + shadcn/ui';
                
                const suiteCmds = [
                    `npm install`,
                    `npm install react-router-dom@7 zustand`,
                    `npm install -D tailwindcss @tailwindcss/vite @types/node`,
                    // -s (--silent) évite le prompt interactif "Use --force / --legacy-peer-deps"
                    // qui bloque le script en React 19 + npm (voir https://ui.shadcn.com/docs/react-19)
                    `npx shadcn@latest init -d -s`
                ];

                if (enDansDossier) {
                    commandesInit = [
                        ...prepareAndScaffold('.', 'react-ts'),
                        ...suiteCmds
                    ];
                } else {
                    commandesInit = [
                        ...prepareAndScaffold(session.nomProjet, 'react-ts'),
                        `Set-Location "${session.nomProjet}"`,
                        ...suiteCmds,
                        `code .`
                    ];
                }
            } else if (framework === 'angular') {
                // Angular garde l'approche classique car @angular/cli a un flag --defaults parfait
                descriptionStack = 'Angular 19 + Angular Router + NgRx Signals + Tailwind CSS v4';
                if (enDansDossier) {
                    commandesInit = [
                        `npx @angular/cli@latest new "${session.nomProjet}" --routing --style=css --skip-git --directory . --defaults`,
                        `npm install -D tailwindcss @tailwindcss/postcss`
                    ];
                } else {
                    commandesInit = [
                        `npx @angular/cli@latest new "${session.nomProjet}" --routing --style=css --skip-git --defaults`,
                        `Set-Location "${session.nomProjet}"; npm install -D tailwindcss @tailwindcss/postcss`,
                        `code .`
                    ];
                }
            } else {
                descriptionStack = 'Vue 3.5 + Vite 7 + Pinia + vue-router 5 + Tailwind CSS v4 + shadcn-vue (Vega)';
                
                const suiteCmds = [
                    `npm install`,
                    `npm install pinia vue-router@5`,
                    `npm install -D tailwindcss @tailwindcss/vite @types/node`,
                    `npx shadcn-vue@latest init -d --style vega`
                ];

                if (enDansDossier) {
                    commandesInit = [
                        ...prepareAndScaffold('.', 'vue-ts'),
                        ...suiteCmds
                    ];
                } else {
                    commandesInit = [
                        ...prepareAndScaffold(session.nomProjet, 'vue-ts'),
                        `Set-Location "${session.nomProjet}"`,
                        ...suiteCmds,
                        `code .`
                    ];
                }
            }

            stream.markdown(`🏗️ **Création du projet \`${session.nomProjet}\` — ${descriptionStack}**\n\n`);
            if (enDansDossier) {
                stream.markdown('> 📂 Installation dans le dossier de workspace actuel.\n\n');
                stream.markdown('> ⚠️ **Attention** : si ce dossier n\'est pas vide, les fichiers existants (hors `.git`) seront **supprimés** pour permettre le scaffolding Vite.\n\n');
            }
            stream.markdown('> ⚙️ Configuration automatisée en cours (fichiers, alias et UI)...\n\n');

            executerScriptSecurise(commandesInit);
            reinitialiserSession(threadId);
            break;
        }

    // --- PHASE EXPORT ---
    case "EXPORT_NOM_SOLUTION": {
      if (!messageUtilisateur) break;
      session.nomSolution = messageUtilisateur;
      session.etat = "EXPORT_ID_SOURCE";

      stream.markdown(`✅ Solution : **${session.nomSolution}**\n\n`);
      stream.markdown(
        "Quel est l'**ID de l'environnement source** (où se trouve l'application) ?\n",
      );
      stream.markdown(
        "> _(Cela permet de rafraîchir votre authentification MFA avant l'export)_",
      );
      break;
    }

    case "EXPORT_ID_SOURCE": {
      if (!messageUtilisateur) break;
      session.idSource = messageUtilisateur;

      stream.markdown(`🔄 **Authentification et Export en cours...**\n\n`);
      stream.markdown(
        "Le terminal gère l'export. Pendant ce temps, voici comment remplir le fichier qui va s'ouvrir :\n\n",
      );

      // Le tutoriel qui remplace les commentaires JSON
      stream.markdown(
        "### 📖 Comment remplir le fichier `deploymentsettings.json` ?\n",
      );
      stream.markdown(
        "1. Allez sur `make.powerapps.com` > **Environnement Cible** > **Connexions**.\n",
      );
      stream.markdown(
        "2. Cliquez sur chaque connexion requise (Dataverse, O365, etc.).\n",
      );
      stream.markdown(
        "3. Copiez l'ID (le GUID) situé à la toute fin de l'URL de votre navigateur.\n",
      );
      stream.markdown(
        '4. Collez cet ID dans le champ `"ConnectionId": ""` correspondant.\n',
      );
      stream.markdown(
        "5. Sauvegardez le fichier (`Ctrl+S`), puis tapez `@Expertees-Deploy 4`.\n\n",
      );

      // Ajout de la commande "code" à la fin du script pour ouvrir le fichier !
      const commandesExport = [
        `pac auth create --environment ${session.idSource}`,
        `pac solution export --name ${session.nomSolution} --path ./exports --managed false`,
        `pac solution export --name ${session.nomSolution} --path ./exports --managed true`,
        `pac solution create-settings --solution-zip ./exports/${session.nomSolution}_managed.zip --settings-file ./deploymentsettings.json`,
        `code ./deploymentsettings.json`, // Ouvre automatiquement le fichier dans l'éditeur
      ];
      executerScriptSecurise(commandesExport);

      reinitialiserSession(threadId);
      break;
    }

    // --- PHASE IMPORT ---
    case "IMPORT_NOM_SOLUTION": {
      if (!messageUtilisateur) break;
      session.nomSolution = messageUtilisateur;
      session.etat = "IMPORT_ID_CIBLE";
      stream.markdown(
        `✅ Solution : **${session.nomSolution}**\n\nQuel est l\'**ID de l\'environnement cible** ?`,
      );
      break;
    }

    case "IMPORT_ID_CIBLE": {
      if (!messageUtilisateur) break;
      session.idCible = messageUtilisateur;

      stream.markdown(
        `🔥 **Lancement du déploiement vers ${session.idCible} !**\n\n`,
      );

      // Utilisation de --environment au lieu de --url
      const commandesImport = [
        `pac auth create --environment ${session.idCible}`,
        `pac auth select --index 1`,
        `pac solution import --path ./exports/${session.nomSolution}_managed.zip --settings-file ./deploymentsettings.json`,
      ];
      executerScriptSecurise(commandesImport);

      reinitialiserSession(threadId);
      break;
    }

    // --- PHASE CODE APP ---
    case "CODE_APP_PUSH_CONFIRM": {
      if (
        messageNormalise === "oui" ||
        messageNormalise === "o" ||
        messageNormalise === "yes"
      ) {
        stream.markdown("⬆️ **Compilation et push en cours...**\n\n");
        stream.markdown(
          "> 1. `npm run build` — génération du dossier `dist`\n",
        );
        stream.markdown(
          "> 2. `npx power-apps push` — envoi vers Dataverse\n\n",
        );

        // Script bloc unique : build + push avec gestion d'erreur intégrée.
        // En cas d'ApplicationNotFound, l'appId obsolète est supprimé de
        // power.config.json et le push est relancé automatiquement.
        const scriptPush = [
          `& {`,
          `Write-Host "🔨 Compilation du projet..." -ForegroundColor Cyan;`,
          `npm run build;`,
          `if ($LASTEXITCODE -ne 0) {`,
          `  Write-Host "❌ Compilation échouée. Corrigez les erreurs TypeScript/Vite avant de réessayer." -ForegroundColor Red;`,
          `  return`,
          `};`,
          `Write-Host "⬆️ Push vers Dataverse..." -ForegroundColor Cyan;`,
          `$pushOut = npx power-apps push 2>&1;`,
          `$pushOut | ForEach-Object { Write-Host $_ };`,
          `if ($LASTEXITCODE -ne 0) {`,
          `  $outStr = $pushOut | Out-String;`,
          `  Write-Host "";`,
          `  if ($outStr -match 'ApplicationNotFound|could not be found') {`,
          `    Write-Host "⚠️ Application introuvable — appId obsolète détecté." -ForegroundColor Yellow;`,
          `    $configPath = Join-Path (Get-Location) 'power.config.json';`,
          `    if (Test-Path $configPath) {`,
          `      Write-Host "🔧 Suppression de l'appId dans power.config.json..." -ForegroundColor Cyan;`,
          `      $cfg = Get-Content $configPath -Raw | ConvertFrom-Json;`,
          `      $cfg.PSObject.Properties.Remove('appId');`,
          `      $cfg | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8;`,
          `      Write-Host "✅ appId supprimé. Nouvelle tentative de push..." -ForegroundColor Green;`,
          `      npx power-apps push;`,
          `      if ($LASTEXITCODE -ne 0) {`,
          `        Write-Host "❌ Push échoué après réinitialisation de l'appId." -ForegroundColor Red;`,
          `        Write-Host "👉 Vérifiez que vous êtes connecté au bon environnement (Code App > Initialiser)." -ForegroundColor Cyan`,
          `      } else {`,
          `        Write-Host "✅ Push terminé avec succès !" -ForegroundColor Green`,
          `      }`,
          `    } else {`,
          `      Write-Host "❌ power.config.json introuvable dans le dossier courant." -ForegroundColor Red`,
          `    }`,
          `  } elseif ($outStr -match 'Unauthorized|401|auth') {`,
          `    Write-Host "❌ Erreur d'authentification." -ForegroundColor Red;`,
          `    Write-Host "👉 Relancez 'pac auth create --environment <ID>' dans le terminal puis retentez le push." -ForegroundColor Cyan`,
          `  } else {`,
          `    Write-Host "❌ Push échoué. Consultez l'erreur ci-dessus." -ForegroundColor Red`,
          `  }`,
          `} else {`,
          `  Write-Host "✅ Push terminé avec succès !" -ForegroundColor Green`,
          `}`,
          `}`,
        ].join(" ");

        executerDansTerminal(scriptPush);
        reinitialiserSession(threadId);
        break;
      }

      if (
        messageNormalise === "non" ||
        messageNormalise === "n" ||
        messageNormalise === "no"
      ) {
        stream.markdown("↩️ Push annulé. Retour au menu principal.\n\n");
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      stream.markdown(
        "❓ Répondez **oui** pour confirmer le push, ou **non** pour revenir au menu.\n",
      );
      break;
    }

    case "CODE_APP_MENU": {
      if (messageNormalise === "menu" || messageNormalise === "retour") {
        session.etat = "MENU_PRINCIPAL";
        afficherMenuPrincipal(stream);
        break;
      }

      if (
        messageNormalise === "1" ||
        messageNormalise === "prérequis" ||
        messageNormalise === "prerequis"
      ) {
        await verifierPrerequisCodeApp(stream, session);
        stream.markdown("---\n\n");

        if (session.codeAppManquants.length === 0) {
          session.etat = "CODE_APP_INIT_CONFIRM";
          stream.markdown(
            "✅ **Toutes les extensions VS Code sont présentes !**\n\n",
          );
          stream.markdown(
            "> Consultez le terminal pour les résultats Node.js, Git et SDK.\n\n",
          );
          stream.markdown(
            "---\n\n**Souhaitez-vous initialiser ce projet en Power Apps Code App ?**\n\n",
          );
          stream.markdown(
            "> Répondez **oui** pour continuer, ou **non** pour revenir au menu.\n",
          );
        } else {
          session.etat = "CODE_APP_PREREQ_INSTALL";
          stream.markdown("⚠️ **Des extensions VS Code sont manquantes.**\n\n");
          stream.markdown(
            "**Souhaitez-vous automatiser l'installation des prérequis manquants ?**\n\n",
          );
          stream.markdown(
            "> Répondez **oui** pour lancer l'installation, ou **non** pour revenir au menu.\n",
          );
        }
        break;
      }

      if (messageNormalise === "2" || messageNormalise === "initialiser") {
        session.etat = "CODE_APP_INIT_ENV";
        stream.markdown("## 🚀 Initialisation en Power Apps Code App\n\n");
        stream.markdown(
          "Quel est l'**ID de votre environnement Power Platform** ?\n\n",
        );
        stream.markdown("> _Ex : `12345678-abcd-1234-abcd-1234567890ab`_\n");
        break;
      }

      afficherMenuCodeApp(stream);
      break;
    }

    case "CODE_APP_PREREQ_INSTALL": {
      if (
        messageNormalise === "oui" ||
        messageNormalise === "o" ||
        messageNormalise === "yes"
      ) {
        await installerPrerequisCodeApp(stream, session);
        session.etat = "CODE_APP_INIT_CONFIRM";
        stream.markdown("\n---\n\n");
        stream.markdown(
          "✅ **Installation terminée.** Vérifiez le terminal pour confirmer.\n\n",
        );
        stream.markdown(
          "**Souhaitez-vous initialiser ce projet en Power Apps Code App ?**\n\n",
        );
        stream.markdown(
          "> Répondez **oui** pour démarrer la configuration guidée, ou **non** pour revenir au menu.\n",
        );
        break;
      }

      if (
        messageNormalise === "non" ||
        messageNormalise === "n" ||
        messageNormalise === "no"
      ) {
        stream.markdown("↩️ Retour au menu principal.\n\n");
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      stream.markdown(
        "❓ Répondez **oui** pour installer automatiquement, ou **non** pour revenir au menu.\n",
      );
      break;
    }

    case "CODE_APP_INIT_CONFIRM": {
      if (
        messageNormalise === "oui" ||
        messageNormalise === "o" ||
        messageNormalise === "yes"
      ) {
        session.etat = "CODE_APP_INIT_ENV";
        stream.markdown("## 🚀 Initialisation en Power Apps Code App\n\n");
        stream.markdown(
          "Quel est l'**ID de votre environnement Power Platform** ?\n\n",
        );
        stream.markdown("> _Ex : `12345678-abcd-1234-abcd-1234567890ab`_\n");
        break;
      }

      if (
        messageNormalise === "non" ||
        messageNormalise === "n" ||
        messageNormalise === "no"
      ) {
        stream.markdown("↩️ Retour au menu principal.\n\n");
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      stream.markdown(
        "❓ Répondez **oui** pour initialiser le projet, ou **non** pour revenir au menu.\n",
      );
      break;
    }

    // --- CONNEXION : CHOIX DU COMPTE PAC ---
    case "CONNEXION_CHOIX_COMPTE": {
      if (messageNormalise === "menu" || messageNormalise === "retour") {
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      if (messageNormalise === "0") {
        session.etat = "CONNEXION_AJOUT_COMPTE";
        stream.markdown("## ➕ **Ajout d'un nouveau compte**\n\n");
        stream.markdown(
          "> Un navigateur va s'ouvrir pour vous authentifier sur Power Platform.\n\n",
        );
        executerDansTerminal("pac auth create");
        stream.markdown("---\n\n");
        stream.markdown(
          "Une fois l'authentification terminée dans le navigateur, tapez **suite** pour voir la liste des environnements disponibles.\n",
        );
        break;
      }

      const indexCompte = parseInt(messageUtilisateur.trim(), 10);
      if (!isNaN(indexCompte) && indexCompte > 0) {
        session.compteIndex = indexCompte;
        stream.markdown(`✅ **Compte n°${indexCompte} sélectionné.**\n\n`);
        executerDansTerminal(`pac auth select --index ${indexCompte}`);
        stream.markdown(
          "> Récupération de la liste des environnements accessibles...\n\n",
        );
        executerDansTerminal("pac env list");
        session.etat = "CONNEXION_CHOIX_ENV";
        stream.markdown("---\n\n");
        stream.markdown("**Quel environnement souhaitez-vous utiliser ?**\n\n");
        stream.markdown(
          "> Tapez l'**URL** ou l'**ID** de l'environnement (visible dans le terminal), ou `menu` pour revenir.\n",
        );
        break;
      }

      stream.markdown(
        "❓ Saisie non reconnue. Tapez un **numéro de compte**, `0` pour ajouter un compte, ou `menu` pour revenir.\n",
      );
      break;
    }

    // --- CONNEXION : AJOUT D'UN NOUVEAU COMPTE ---
    case "CONNEXION_AJOUT_COMPTE": {
      if (messageNormalise === "menu" || messageNormalise === "retour") {
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      if (messageNormalise === "suite" || messageNormalise === "continuer") {
        stream.markdown(
          "✅ **Compte ajouté.** Récupération de la liste des environnements...\n\n",
        );
        executerDansTerminal("pac env list");
        session.etat = "CONNEXION_CHOIX_ENV";
        stream.markdown("---\n\n");
        stream.markdown("**Quel environnement souhaitez-vous utiliser ?**\n\n");
        stream.markdown(
          "> Tapez l'**URL** ou l'**ID** de l'environnement (visible dans le terminal), ou `menu` pour revenir.\n",
        );
        break;
      }

      stream.markdown(
        "⏳ Une fois l'authentification terminée dans le navigateur, tapez **suite** pour continuer.\n",
      );
      break;
    }

    // --- CONNEXION : CHOIX DE L'ENVIRONNEMENT ---
    case "CONNEXION_CHOIX_ENV": {
      if (messageNormalise === "menu" || messageNormalise === "retour") {
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      if (!messageUtilisateur) break;

      const envChoisi = messageUtilisateur.trim();
      session.environnementSelectionne = envChoisi;

      stream.markdown(`## 🌍 **Sélection de l'environnement**\n\n`);
      stream.markdown(`> Environnement choisi : \`${envChoisi}\`\n\n`);

      executerScriptSecurise([
        `pac env select --environment "${envChoisi}"`,
        `Write-Host "✅ Environnement sélectionné avec succès !" -ForegroundColor Green`,
      ]);

      const sauvegarde = sauvegarderEnvironnementDansConfig(envChoisi);
      if (sauvegarde) {
        stream.markdown(
          "> 💾 Environnement sauvegardé dans `power.config.json`.\n\n",
        );
      } else {
        stream.markdown(
          "> ℹ️ Aucun fichier `power.config.json` trouvé — l'environnement n'a pas été sauvegardé localement.\n\n",
        );
      }

      stream.markdown("---\n\n");
      stream.markdown(
        "✅ **Connexion et environnement configurés.** Retour au menu principal.\n\n",
      );
      reinitialiserSession(threadId);
      afficherMenuPrincipal(stream);
      break;
    }

    case "CODE_APP_INIT_ENV": {
      if (!messageUtilisateur) break;

      const envId = messageUtilisateur.trim();
      stream.markdown(`## ⚙️ Configuration du projet en Code App\n\n`);
      stream.markdown(`🌍 ID d'environnement : **${envId}**\n\n`);
      stream.markdown("### Étapes lancées dans le terminal :\n");
      stream.markdown(
        "1. 🔐 Authentification sur l'environnement Power Platform\n",
      );
      stream.markdown("2. 📦 Installation du SDK **@microsoft/power-apps**\n");
      stream.markdown("3. 🔧 Initialisation du projet Code App\n\n");
      stream.markdown(
        "> ✅ Suivez les instructions dans le terminal. Une fois terminé, utilisez **3** (`run`) pour démarrer le proxy.\n\n",
      );

      const commandesCodeApp = [
        `Write-Host "🔐 Authentification Power Platform..." -ForegroundColor Cyan`,
        `pac auth create --environment "${envId}"`,
        `Write-Host "📦 Installation du SDK @microsoft/power-apps..." -ForegroundColor Cyan`,
        `npm install @microsoft/power-apps`,
        `Write-Host "🔧 Initialisation du projet Code App..." -ForegroundColor Cyan`,
        `npx power-apps init`,
        `Write-Host "✅ Projet initialisé avec succès !" -ForegroundColor Green`,
      ];
      executerScriptSecurise(commandesCodeApp);

      reinitialiserSession(threadId);
      break;
    }
  }

  return {};
}

function afficherMenuPrincipal(stream: vscode.ChatResponseStream): void {
  stream.markdown("# 🚀 Bienvenue sur **ExperteesDeploy**\n\n");
  stream.markdown(
    "> Votre assistant de déploiement Power Platform. Il vous guide pas à pas pour exporter, configurer et importer vos solutions Dataverse entre environnements, directement depuis VS Code.\n\n",
  );
  stream.markdown("---\n\n");
  stream.markdown("## Menu principal\n\n");
  stream.markdown("| # | Action | Description |\n");
  stream.markdown("|---|--------|-------------|\n");
  stream.markdown(
    "| **1** | `init` | Initialiser un projet front-end (Vue · React · Angular) avec la stack Expertime |\n",
  );
  stream.markdown(
    "| **2** | `codeapp` | Transformer le projet en Power Apps Code App |\n",
  );
  stream.markdown("| **3** | `run` | Démarrer proxy & serveur local |\n");
  stream.markdown("| **4** | `push` | Pousser le Code App (Inner-loop) |\n");
  stream.markdown(
    "| **5** | `connexion` | Gérer la connexion et sélectionner l'environnement Power Platform |\n\n",
  );
}

export function activate(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant(
    "expertees-deploy.agent",
    gererRequete,
  );
  participant.iconPath = new vscode.ThemeIcon("rocket");
  context.subscriptions.push(participant);
}

export function deactivate() {}
