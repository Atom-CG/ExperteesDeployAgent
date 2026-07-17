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
  | "CODE_APP_MENU"
  | "CODE_APP_PREREQ_INSTALL"
  | "CODE_APP_INIT_CONFIRM"
  | "CODE_APP_INIT_ENV"
  | "CODE_APP_PUSH_CONFIRM"
  | "CONNEXION_CHOIX_COMPTE"
  | "CONNEXION_AJOUT_COMPTE"
  | "CONNEXION_CHOIX_ENV"
  | "CONNEXION_SAUV_PROPOSITION"
  | "CONNEXION_SAUV_ALIAS"
  | "MAJ_CONFIRM"
  | "MAJ_RELOAD_CONFIRM";

interface SessionALM {
  etat: EtatConversation;
  nomProjet: string;
  frameworkChoisi: string;
  codeAppManquants: string[];
  compteIndex: number;
  environnementSelectionne: string;
}

const NOM_TERMINAL = "Power ALM ExperteesDeploy";
// Pour l'inner-loop (`run`) : on sépare volontairement le serveur local (Vite/Angular/...)
// et le proxy Power Apps dans deux terminaux distincts, pour que chaque process ait sa
// propre sortie stdout lisible et son propre code de sortie observable.
const NOM_TERMINAL_APP = "ExperteesDeploy - App (dev server)";
const NOM_TERMINAL_PROXY = "ExperteesDeploy - Power Apps proxy";
const sessions = new Map<string, SessionALM>();

function obtenirOuCreerSession(threadId: string): SessionALM {
  if (!sessions.has(threadId)) {
    sessions.set(threadId, {
      etat: "MENU_PRINCIPAL",
      nomProjet: "",
      frameworkChoisi: "",
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
// power.config.json — HELPERS GÉNÉRIQUES DE LECTURE/ÉCRITURE
// ---------------------------------------------------------------------------
// Toutes les fonctions ci-dessous lisaient/écrivaient power.config.json en dupliquant
// le même enchaînement workspaceFolders → path.join → existsSync → readFileSync →
// JSON.parse (+ try/catch). Centralisé ici : `lireConfig` pour la lecture brute,
// `ecrireConfig` pour un patch fusionné (merge shallow avec le contenu existant).

type PowerConfig = Record<string, any>;

function cheminConfigPower(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  return path.join(workspaceFolders[0].uri.fsPath, "power.config.json");
}

function lireConfig(): PowerConfig | undefined {
  const configPath = cheminConfigPower();
  if (!configPath || !fs.existsSync(configPath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Fusionne `patch` dans power.config.json (merge shallow avec le contenu existant).
 * `creerSiAbsent` : si `false` (défaut), n'écrit rien tant que le fichier n'existe pas déjà
 * — comportement d'origine de `mettreAJourLocalAppUrl`. Mettre `true` pour reproduire le
 * comportement d'origine de `sauvegarderEnvironnementDansConfig`, qui créait le fichier.
 */
function ecrireConfig(patch: PowerConfig, creerSiAbsent = false): boolean {
  const configPath = cheminConfigPower();
  if (!configPath) {
    return false;
  }
  if (!fs.existsSync(configPath) && !creerSiAbsent) {
    return false;
  }

  const configActuelle = lireConfig() ?? {};
  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...configActuelle, ...patch }, null, 2),
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// LECTURE DE L'URL DU SERVEUR DEPUIS power.config.json
// ---------------------------------------------------------------------------

function lireUrlServeur(): string | undefined {
  const config = lireConfig();
  if (!config) {
    return undefined;
  }

  try {
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

// Met à jour le champ localAppUrl dans power.config.json.
// N'écrit rien si le fichier n'existe pas encore (comportement d'origine).
function mettreAJourLocalAppUrl(port: number): boolean {
  return ecrireConfig({ localAppUrl: `http://localhost:${port}` });
}

async function ouvrirNavigateurServeur(
  stream: vscode.ChatResponseStream,
): Promise<void> {
  // 8s au lieu de 3s : le run fait maintenant démarrer 2 processus en séquence
  // (vite d'abord, attente TCP, puis power-apps run). Le proxy a besoin de temps
  // supplémentaire pour tunneler avant que le lien navigateur ne soit fonctionnel.
  const DELAI_DEMARRAGE_MS = 8000;
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

// Sauvegarde l'environnement choisi (menu "connexion"). Contrairement à
// `mettreAJourLocalAppUrl`, crée le fichier power.config.json s'il n'existe pas encore
// (comportement d'origine).
function sauvegarderEnvironnementDansConfig(envUrl: string): boolean {
  return ecrireConfig({ selectedEnvironment: envUrl }, /* creerSiAbsent */ true);
}

// Relit le dernier environnement sauvegardé (pour proposer sa réutilisation par défaut).
function lireEnvironnementSauvegarde(): string | undefined {
  const config = lireConfig();
  return typeof config?.selectedEnvironment === "string"
    ? config.selectedEnvironment
    : undefined;
}

// Relit l'ID d'environnement écrit par `power-apps init` dans power.config.json
// (champ `environmentId`, distinct de `selectedEnvironment` géré par le menu "connexion").
// Permet de rafraîchir la connexion PAC avant `run`/`push` SANS redemander l'ID à l'utilisateur.
function lireEnvironmentIdCodeApp(): string | undefined {
  const config = lireConfig();
  const id = config?.environmentId ?? config?.environment_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// ---------------------------------------------------------------------------
// CONNEXIONS SAUVEGARDÉES DANS LE PROJET (.experdeploy.json)
// ---------------------------------------------------------------------------
// Stockage séparé de power.config.json : ce dernier est un fichier officiel Microsoft
// susceptible d'être réécrit par `power-apps init`/`push` ; les préréglages ExperteesDeploy
// vivent donc dans leur propre fichier, gitignorable ou versionnable au choix de l'équipe.

interface ConnexionSauvegardee {
  alias: string;
  compteIndex: number;
  environnementUrl: string;
}

interface ExperdeployProjectConfig {
  connexions?: ConnexionSauvegardee[];
}

const FICHIER_CONFIG_EXPERDEPLOY = ".experdeploy.json";
const ALIAS_VALIDE = /^[A-Za-z0-9._-]{1,32}$/;

function cheminConfigExperdeploy(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  return path.join(workspaceFolders[0].uri.fsPath, FICHIER_CONFIG_EXPERDEPLOY);
}

function lireConfigExperdeploy(): ExperdeployProjectConfig {
  const p = cheminConfigExperdeploy();
  if (!p || !fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ExperdeployProjectConfig;
  } catch {
    return {};
  }
}

function ecrireConfigExperdeploy(cfg: ExperdeployProjectConfig): boolean {
  const p = cheminConfigExperdeploy();
  if (!p) {
    return false;
  }
  try {
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

function listerConnexionsSauvegardees(): ConnexionSauvegardee[] {
  return lireConfigExperdeploy().connexions ?? [];
}

function trouverConnexionParAlias(alias: string): ConnexionSauvegardee | undefined {
  const cible = alias.toLowerCase();
  return listerConnexionsSauvegardees().find((c) => c.alias.toLowerCase() === cible);
}

/** Ajoute (ou remplace) une connexion sauvegardée. Retourne false si l'écriture échoue. */
function sauvegarderConnexion(nouvelle: ConnexionSauvegardee): boolean {
  const cfg = lireConfigExperdeploy();
  const liste = cfg.connexions ?? [];
  const idx = liste.findIndex(
    (c) => c.alias.toLowerCase() === nouvelle.alias.toLowerCase(),
  );
  if (idx >= 0) {
    liste[idx] = nouvelle;
  } else {
    liste.push(nouvelle);
  }
  cfg.connexions = liste;
  return ecrireConfigExperdeploy(cfg);
}

function supprimerConnexion(alias: string): boolean {
  const cfg = lireConfigExperdeploy();
  const liste = cfg.connexions ?? [];
  const cible = alias.toLowerCase();
  const restant = liste.filter((c) => c.alias.toLowerCase() !== cible);
  if (restant.length === liste.length) {
    return false; // rien à supprimer
  }
  cfg.connexions = restant;
  return ecrireConfigExperdeploy(cfg);
}

// ---------------------------------------------------------------------------
// UTILITAIRES TERMINAL
// ---------------------------------------------------------------------------

function obtenirOuCreerTerminalNomme(nom: string): vscode.Terminal {
  const existant = vscode.window.terminals.find((t) => t.name === nom);
  if (existant) {
    return existant;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const cwd =
    workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : undefined;

  return vscode.window.createTerminal({ name: nom, cwd: cwd });
}

function obtenirOuCreerTerminal(): vscode.Terminal {
  return obtenirOuCreerTerminalNomme(NOM_TERMINAL);
}

function executerDansTerminal(commande: string): void {
  const terminal = obtenirOuCreerTerminal();
  terminal.show(true);
  terminal.sendText(commande);
}

/**
 * Envoie une chaîne de commandes PowerShell au terminal, avec arrêt automatique à la
 * première erreur (`$experdeployAbort`). Sans `options.bilan` : reproduit le comportement
 * d'origine de `executerScriptSecurise` (message d'erreur générique par étape, pas de
 * récapitulatif final). Avec `options.bilan` : reproduit `executerScriptSecuriseAvecBilan`
 * (message d'erreur numéroté + code de sortie par étape, journal des erreurs, bilan final
 * succès/échec).
 */
function executerScript(commandes: string[], options?: { bilan?: string }): void {
  const terminal = obtenirOuCreerTerminal();
  terminal.show(true);

  // $LASTEXITCODE n'est modifié QUE par les commandes natives (npm, npx, node...).
  // Les cmdlets/appels .NET (ex: [IO.File]::WriteAllBytes, Remove-Item, Set-Location) le
  // laissent inchangé : sur un terminal fraîchement créé il vaut $null, donc
  // `$LASTEXITCODE -ne 0` serait vrai à tort (`$null -ne 0` => `$true`) dès la 1ère étape.
  // On l'initialise à 0 et on combine avec `$?` (reflète aussi l'échec des cmdlets).
  //
  // ⚠️ `break` seul ne stoppe PAS la chaîne : chaque commande est envoyée séparément
  // via `terminal.sendText()` à un terminal interactif déjà lancé, pas exécutée dans une
  // boucle/script unique. `break` hors de tout `for`/`while` n'a donc aucun effet sur les
  // lignes suivantes déjà mises en file — elles s'exécutent quand même (bug observé : un
  // message "✅ succès" s'affichait après un échec réel de `npx power-apps init`). On
  // utilise donc le garde-fou `$experdeployAbort` dans les deux variantes.
  const initVars = options?.bilan
    ? "$experdeployAbort = $false; $experdeployErreurs = @(); $global:LASTEXITCODE = 0"
    : "$experdeployAbort = $false; $global:LASTEXITCODE = 0";
  terminal.sendText(initVars);

  commandes.forEach((cmd, index) => {
    const commandeSecurisee = options?.bilan
      ? (() => {
          const etape = index + 1;
          return `if (-not $experdeployAbort) { ${cmd}; if ((-not $?) -or ($LASTEXITCODE -ne 0)) { $codeAffiche = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 'n/a' }; $msg = "❌ Étape ${etape}/${commandes.length} échouée (code de sortie: $codeAffiche)"; Write-Host $msg -ForegroundColor Red; $experdeployErreurs += $msg; $experdeployAbort = $true } }`;
        })()
      : `if (-not $experdeployAbort) { ${cmd}; if ((-not $?) -or ($LASTEXITCODE -ne 0)) { Write-Host '❌ Arrêt du script suite à une erreur.' -ForegroundColor Red; $experdeployAbort = $true } }`;
    terminal.sendText(commandeSecurisee);
  });

  if (options?.bilan) {
    const messageEchappe = options.bilan.replace(/'/g, "''");
    terminal.sendText(
      `if ($experdeployAbort) { Write-Host ''; Write-Host '❌ ${messageEchappe} — ÉCHEC' -ForegroundColor Red; Write-Host '--- Journal des erreurs ---' -ForegroundColor Red; $experdeployErreurs | ForEach-Object { Write-Host $_ -ForegroundColor Red } } else { Write-Host ''; Write-Host '✅ ${messageEchappe} — SUCCÈS' -ForegroundColor Green }`,
    );
  }
}

// Wrappers conservés pour ne pas modifier les ~10 points d'appel existants dans le fichier.
function executerScriptSecurise(commandes: string[]): void {
  executerScript(commandes);
}

function executerScriptSecuriseAvecBilan(
  commandes: string[],
  messageSucces: string,
): void {
  executerScript(commandes, { bilan: messageSucces });
}

// ---------------------------------------------------------------------------
// POWER APPS CODE APP — PRÉREQUIS ET INITIALISATION
// ---------------------------------------------------------------------------

function afficherMenuCodeApp(stream: vscode.ChatResponseStream): void {
  stream.markdown(`## 📱 **Power Apps Code App**

> Configurez votre projet actuel pour le connecter à Power Apps Code First.

---

| # | Action | Description |
|---|--------|-------------|
| **1** | \`prérequis\` | Vérifier et installer les prérequis |
| **2** | \`initialiser\` | Initialiser directement le projet |

> Tapez **menu** pour revenir au menu principal.
`);
}

/** Affiche le menu de gestion de la connexion, avec la liste des connexions sauvegardées
 *  dans `.experdeploy.json` si présentes. Déclenche `pac auth list` dans le terminal. */
function afficherMenuConnexion(stream: vscode.ChatResponseStream): void {
  const connexions = listerConnexionsSauvegardees();

  stream.markdown(`## 🔐 **Gestion de la connexion Power Platform**

> La liste de vos profils PAC s'affiche dans le terminal ci-dessous.

`);
  executerDansTerminal("pac auth list");

  if (connexions.length > 0) {
    const lignes = connexions
      .map(
        (c) =>
          `| \`${c.alias}\` | Compte pac #${c.compteIndex} → ${c.environnementUrl} |`,
      )
      .join("\n");
    stream.markdown(`
### ⭐ Connexions sauvegardées dans ce projet

| Alias | Cible |
|-------|-------|
${lignes}

> Tapez l'**alias** pour basculer directement dessus (compte + environnement en une passe).

`);
  }

  stream.markdown(`---

| Saisie | Action |
|--------|--------|
| \`N°\` | Utiliser le profil pac correspondant (ex : \`1\`) |
| \`0\` | Ajouter un nouveau compte |
${connexions.length > 0 ? "| `alias` | Appliquer une connexion sauvegardée |\n| `del <alias>` | Supprimer une connexion sauvegardée |\n" : ""}| \`menu\` | Revenir au menu principal |

> ⬆️ Consultez le terminal pour voir vos comptes disponibles, puis répondez ici.
`);
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
// TRADUCTION AUTOMATIQUE (si VS Code est configuré en anglais)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POWER APPS CODE APP — PROMPT ENVIRONNEMENT (avec réutilisation)
// ---------------------------------------------------------------------------

/** Affiche la question de l'ID d'environnement, en proposant de réutiliser le dernier connu. */
function afficherPromptEnvironnementCodeApp(
  stream: vscode.ChatResponseStream,
): void {
  stream.markdown("## 🚀 Initialisation en Power Apps Code App\n\n");
  stream.markdown(
    "Quel est l'**ID de votre environnement Power Platform** ?\n\n",
  );
  const envSauvegarde = lireEnvironnementSauvegarde();
  if (envSauvegarde) {
    stream.markdown(
      `> 💡 Environnement précédent détecté : \`${envSauvegarde}\` — répondez avec un **message vide** (juste Entrée) pour le réutiliser.\n`,
    );
  } else {
    stream.markdown("> _Ex : `12345678-abcd-1234-abcd-1234567890ab`_\n");
  }
}

// ---------------------------------------------------------------------------
// POWER APPS CODE APP — PUSH (INNER-LOOP)
// ---------------------------------------------------------------------------

/** Compile puis pousse le Code App vers Dataverse, avec gestion des erreurs courantes. */
async function lancerPushCodeApp(
  stream: vscode.ChatResponseStream,
  threadId: string,
): Promise<void> {
  stream.markdown(`⬆️ **Compilation et push en cours...**

> 1. \`npm run build\` — génération du dossier \`dist\`
> 2. \`npx power-apps push\` — envoi vers Dataverse

`);

  // Script bloc unique : build + push avec gestion d'erreur intégrée.
  // En cas d'ApplicationNotFound, l'appId obsolète est supprimé de
  // power.config.json et le push est relancé automatiquement.
  const scriptPush = [
    `& {`,
    // Auto-fix préventif AVANT le build : Power Apps Code Apps exigent des chemins relatifs
    // dans index.html. Sans "base: './'" (Vite) ou "baseHref: './'" (Angular), les bundlers
    // génèrent des chemins absolus (/assets/index-XXX.css) qui donnent des 404 sur le CDN
    // powerplatformusercontent.com une fois l'app déployée — même si "power-apps push"
    // affiche "successfully". Contrairement au patch TS5101 (réactif, sur échec de build),
    // celui-ci est proactif : le symptôme n'apparaît qu'au runtime côté serveur.
    // --- Vite (Vue/React) ---
    `foreach ($viteFile in @('vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs')) {`,
    `  if (Test-Path $viteFile) {`,
    `    $viteContent = Get-Content $viteFile -Raw;`,
    `    if ($viteContent -notmatch '(?m)(^|\\W)base\\s*:') {`,
    `      Write-Host "🔧 Patch $viteFile : ajout de base: './' (requis pour Power Apps Code Apps)..." -ForegroundColor Cyan;`,
    `      $viteContent = $viteContent -replace 'defineConfig\\s*\\(\\s*\\{', "defineConfig({\`n  base: './',";`,
    `      Set-Content $viteFile -Value $viteContent -Encoding UTF8;`,
    `      Write-Host "✅ $viteFile patché." -ForegroundColor Green;`,
    `    }`,
    `    break`,
    `  }`,
    `};`,
    // --- Angular ---
    `if (Test-Path 'angular.json') {`,
    `  try {`,
    `    $ng = Get-Content 'angular.json' -Raw | ConvertFrom-Json;`,
    `    $names = @($ng.projects.PSObject.Properties.Name);`,
    `    if ($names.Count -gt 0) {`,
    `      $name = $names[0];`,
    `      $bt = $null;`,
    `      if ($ng.projects.$name.architect -and $ng.projects.$name.architect.build) { $bt = $ng.projects.$name.architect.build }`,
    `      elseif ($ng.projects.$name.targets -and $ng.projects.$name.targets.build) { $bt = $ng.projects.$name.targets.build };`,
    `      if ($bt -and $bt.options -and $bt.options.baseHref -ne './') {`,
    `        Write-Host "🔧 Patch angular.json : ajout de baseHref: './' (requis pour Power Apps Code Apps)..." -ForegroundColor Cyan;`,
    `        $bt.options | Add-Member -MemberType NoteProperty -Name baseHref -Value './' -Force;`,
    `        $ng | ConvertTo-Json -Depth 100 | Set-Content 'angular.json' -Encoding UTF8;`,
    `        Write-Host "✅ angular.json patché." -ForegroundColor Green;`,
    `      }`,
    `    }`,
    `  } catch { Write-Host "⚠️ angular.json non patchable (JSON invalide ?)." -ForegroundColor Yellow }`,
    `};`,
    `Write-Host "🔨 Compilation du projet..." -ForegroundColor Cyan;`,
    // Capture de la sortie pour pouvoir détecter TS5101 (baseUrl déprécié en TS 5+) et
    // auto-patcher les tsconfig si besoin. Utile pour les projets scaffoldés avant l'ajout
    // de ignoreDeprecations dans le script d'init.
    `$buildOut = npm run build 2>&1;`,
    `$buildOut | ForEach-Object { Write-Host $_ };`,
    `if ($LASTEXITCODE -ne 0) {`,
    `  $buildStr = $buildOut | Out-String;`,
    `  if ($buildStr -match 'TS5101' -or $buildStr -match "Option 'baseUrl' is deprecated") {`,
    `    Write-Host "";`,
    `    Write-Host "⚠️ TS5101 détecté (baseUrl déprécié en TS 5+) — patch automatique en cours..." -ForegroundColor Yellow;`,
    `    $patched = @();`,
    `    foreach ($tsfile in @('tsconfig.app.json', 'tsconfig.json')) {`,
    `      if (Test-Path $tsfile) {`,
    `        $content = Get-Content $tsfile -Raw;`,
    `        if ($content -notmatch 'ignoreDeprecations') {`,
    `          if ($content -match '"compilerOptions"\\s*:\\s*\\{') {`,
    `            $content = $content -replace '("compilerOptions"\\s*:\\s*\\{)', '$1' + [char]10 + '    "ignoreDeprecations": "6.0",';`,
    `            Set-Content $tsfile -Value $content -Encoding UTF8;`,
    `            $patched += $tsfile;`,
    `          }`,
    `        }`,
    `      }`,
    `    };`,
    `    if ($patched.Count -gt 0) {`,
    `      Write-Host "✅ Patché : $($patched -join ', ')" -ForegroundColor Green;`,
    `      Write-Host "🔨 Nouvelle tentative de compilation..." -ForegroundColor Cyan;`,
    `      npm run build;`,
    `      if ($LASTEXITCODE -ne 0) {`,
    `        Write-Host "❌ Compilation encore échouée après le patch. Corrigez les erreurs restantes." -ForegroundColor Red;`,
    `        return`,
    `      }`,
    `    } else {`,
    `      Write-Host "⚠️ Aucun tsconfig à patcher (ignoreDeprecations déjà présent ou pas de compilerOptions détecté)." -ForegroundColor Yellow;`,
    `      Write-Host "❌ Corrigez manuellement les erreurs TypeScript avant de réessayer." -ForegroundColor Red;`,
    `      return`,
    `    }`,
    `  } else {`,
    `    Write-Host "❌ Compilation échouée. Corrigez les erreurs TypeScript/Vite avant de réessayer." -ForegroundColor Red;`,
    `    return`,
    `  }`,
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
    `    Write-Host "👉 Relancez 'pac auth create --environment <ID> --deviceCode' dans le terminal puis retentez le push." -ForegroundColor Cyan`,
    `  } else {`,
    `    Write-Host "❌ Push échoué. Consultez l'erreur ci-dessus." -ForegroundColor Red`,
    `  }`,
    `} else {`,
    `  Write-Host "✅ Push terminé avec succès !" -ForegroundColor Green`,
    `}`,
    `}`,
  ].join(" ");

  // NOTE (2026-07-10) : l'auto-reconnexion PAC basée sur l'API Shell Integration
  // (`executerAvecAutoReauth`) a été retirée — elle pouvait rester bloquée indéfiniment
  // (aucun événement de fin de commande reçu, même pour un simple `Write-Host`, confirmé
  // en usage réel) alors que la même commande fonctionne normalement dans un terminal
  // classique. `executerScriptSecurise` (sendText, comme une saisie manuelle) est fiable ;
  // en cas de session expirée, le script affiche déjà un message invitant à relancer
  // `pac auth create --environment <ID> --deviceCode` manuellement.
  executerScriptSecurise([scriptPush]);
  reinitialiserSession(threadId);
}

// ---------------------------------------------------------------------------
// SCAFFOLD DE PROJET (Vue · React · Angular)
// ---------------------------------------------------------------------------

/** Construit la liste des commandes PowerShell à exécuter pour scaffolder le projet. */
function construireCommandesScaffold(
  framework: string,
  nomProjet: string,
  enDansDossier: boolean,
): { commandesInit: string[]; descriptionStack: string } {
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

    console.log('🔧 Application des patchs...');
    // shadcn/shadcn-vue lisent les alias de chemin dans le tsconfig.json RACINE (pas seulement
    // tsconfig.app.json) : sans "baseUrl"/"paths" à la racine, l'init échoue avec "Could not load
    // the workspace config ... configure its path aliases". Il faut donc patcher les DEUX fichiers.
    //
    // ⚠️ TS 5.5+ marque "baseUrl" comme déprécié et remonte TS5101 comme erreur bloquante en
    // mode strict. On ajoute "ignoreDeprecations": "6.0" en parallèle : workaround officiel
    // Microsoft qui conserve le comportement TS 6 (baseUrl fonctionnel) jusqu'à TS 7.
    function patchTsconfig(file) {
        if (!fs.existsSync(file)) { return; }
        let ts = fs.readFileSync(file, 'utf8');
        if (ts.includes('"baseUrl"')) { return; }
        const inject = '\\n    "ignoreDeprecations": "6.0",\\n    "baseUrl": ".",\\n    "paths": { "@/*": ["./src/*"] },';
        if (ts.includes('"compilerOptions": {')) {
            ts = ts.replace('"compilerOptions": {', '"compilerOptions": {' + inject);
        } else {
            // tsconfig.json racine de type "solution" (juste files/references, pas de compilerOptions)
            const idx = ts.indexOf('{');
            ts = ts.slice(0, idx + 1) + '\\n  "compilerOptions": {' + inject.replace(/,$/, '') + '\\n  },' + ts.slice(idx + 1);
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
        // OBLIGATOIRE pour Power Apps Code Apps : chemins relatifs dans index.html.
        // Sans "base: './'" Vite génère des chemins absolus (/assets/index-XXX.css) qui ne
        // résolvent pas côté CDN powerplatformusercontent.com → 404 sur les assets une fois
        // l'app déployée, même si le push CLI affiche "successfully".
        if (!/(^|\\W)base\\s*:/.test(vc)) {
            vc = vc.replace(/defineConfig\\(\\s*\\{/, "defineConfig({\\n  base: './',");
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
  const setupBase64 = Buffer.from(setupJs).toString("base64");

  // Génération du fichier temporaire .cjs et exécution (avec passage du dossier et du template)
  //
  // ⚠️ Le script temporaire est écrit dans le dossier TEMP système ($env:TEMP), PAS dans le
  // dossier cible. Quand `cible` vaut "." (scaffold dans le dossier courant), `create-vite
  // --overwrite` (appelé DANS ce script) vide entièrement le dossier cible (hors .git) —
  // si le .cjs était écrit là, il serait supprimé pendant sa propre exécution, et l'étape
  // de nettoyage (Remove-Item) échouerait ensuite avec "Cannot find path" (le fichier
  // n'existant déjà plus). En le plaçant hors du dossier scaffoldé, il survit à
  // --overwrite et le nettoyage final réussit toujours.
  const prepareAndScaffold = (cible: string, template: string) => [
    `$experdeploySetupPath = Join-Path $env:TEMP "expertees-setup-$([guid]::NewGuid().ToString('N')).cjs"`,
    `[IO.File]::WriteAllBytes($experdeploySetupPath, [Convert]::FromBase64String('${setupBase64}'))`,
    `node $experdeploySetupPath "${cible}" "${template}"`,
    `Remove-Item $experdeploySetupPath -ErrorAction SilentlyContinue`,
  ];

  if (framework === "react") {
    descriptionStack =
      "React 19 + Vite 7 + React Router v7 + Zustand + Tailwind CSS v4 + shadcn/ui";

    const suiteCmds = [
      `npm install`,
      `npm install react-router-dom@7 zustand`,
      `npm install -D tailwindcss @tailwindcss/vite @types/node`,
      // -s (--silent) évite le prompt interactif "Use --force / --legacy-peer-deps"
      // qui bloque le script en React 19 + npm (voir https://ui.shadcn.com/docs/react-19)
      `npx shadcn@latest init -d -s`,
    ];

    if (enDansDossier) {
      commandesInit = [...prepareAndScaffold(".", "react-ts"), ...suiteCmds];
    } else {
      commandesInit = [
        ...prepareAndScaffold(nomProjet, "react-ts"),
        `Set-Location "${nomProjet}"`,
        ...suiteCmds,
        `code .`,
      ];
    }
  } else if (framework === "angular") {
    // Angular garde l'approche classique car @angular/cli a un flag --defaults parfait
    descriptionStack =
      "Angular 19 + Angular Router + NgRx Signals + Tailwind CSS v4";

    // Patch angular.json : ajoute baseHref: './' dans le premier projet. Nécessaire pour
    // Power Apps Code Apps — sans ça, ng build génère un index.html avec des chemins
    // absolus (/main-XXX.js) qui donnent des 404 sur le CDN powerplatformusercontent.com
    // une fois l'app déployée. Équivalent Angular du `base: './'` de Vite.
    // Compatible Angular 17+ (architect) et 18+ (targets, alias moderne).
    const patchAngularJson = `if (Test-Path 'angular.json') { try { $ng = Get-Content 'angular.json' -Raw | ConvertFrom-Json; $names = @($ng.projects.PSObject.Properties.Name); if ($names.Count -gt 0) { $name = $names[0]; $bt = $null; if ($ng.projects.$name.architect -and $ng.projects.$name.architect.build) { $bt = $ng.projects.$name.architect.build } elseif ($ng.projects.$name.targets -and $ng.projects.$name.targets.build) { $bt = $ng.projects.$name.targets.build }; if ($bt -and $bt.options -and $bt.options.baseHref -ne './') { $bt.options | Add-Member -MemberType NoteProperty -Name baseHref -Value './' -Force; $ng | ConvertTo-Json -Depth 100 | Set-Content 'angular.json' -Encoding UTF8; Write-Host \\"🔧 angular.json patché : baseHref: './' (requis pour Power Apps Code Apps)\\" -ForegroundColor Cyan } } } catch { Write-Host \\"⚠️ angular.json non patchable (JSON invalide ?)\\" -ForegroundColor Yellow } }`;

    if (enDansDossier) {
      commandesInit = [
        `npx @angular/cli@latest new "${nomProjet}" --routing --style=css --skip-git --directory . --defaults`,
        patchAngularJson,
        `npm install -D tailwindcss @tailwindcss/postcss`,
      ];
    } else {
      commandesInit = [
        `npx @angular/cli@latest new "${nomProjet}" --routing --style=css --skip-git --defaults`,
        `Set-Location "${nomProjet}"; ${patchAngularJson}; npm install -D tailwindcss @tailwindcss/postcss`,
        `code .`,
      ];
    }
  } else {
    descriptionStack =
      "Vue 3.5 + Vite 7 + Pinia + vue-router 5 + Tailwind CSS v4 + shadcn-vue (Vega)";

    const suiteCmds = [
      `npm install`,
      `npm install pinia vue-router@5`,
      `npm install -D tailwindcss @tailwindcss/vite @types/node`,
      `npx shadcn-vue@latest init -d --style vega`,
    ];

    if (enDansDossier) {
      commandesInit = [...prepareAndScaffold(".", "vue-ts"), ...suiteCmds];
    } else {
      commandesInit = [
        ...prepareAndScaffold(nomProjet, "vue-ts"),
        `Set-Location "${nomProjet}"`,
        ...suiteCmds,
        `code .`,
      ];
    }
  }

  return { commandesInit, descriptionStack };
}

/** Affiche le résumé et lance le scaffold complet (commandes + bilan) pour un framework/nom donnés. */
function lancerScaffold(
  stream: vscode.ChatResponseStream,
  threadId: string,
  framework: string,
  nomProjet: string,
): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const enDansDossier = !!(workspaceFolders && workspaceFolders.length > 0);
  const { commandesInit, descriptionStack } = construireCommandesScaffold(
    framework,
    nomProjet,
    enDansDossier,
  );

  stream.markdown(
    `🏗️ **Création du projet \`${nomProjet}\` — ${descriptionStack}**\n\n`,
  );
  if (enDansDossier) {
    stream.markdown(`> 📂 Installation dans le dossier de workspace actuel.

> ⚠️ **Attention** : si ce dossier n'est pas vide, les fichiers existants (hors \`.git\`) seront **supprimés** pour permettre le scaffolding Vite.

`);
  }
  stream.markdown(`> ⚙️ Configuration automatisée en cours (fichiers, alias et UI)...

> 👀 **Surveillez le terminal** : certaines commandes (\`npm\`, \`shadcn\`, Angular CLI, création Vite) peuvent afficher des **prompts de confirmation** — répondez-y au fur et à mesure sinon le script reste bloqué.

`);

  executerScriptSecuriseAvecBilan(
    commandesInit,
    `Initialisation du projet "${nomProjet}" (${descriptionStack})`,
  );
  reinitialiserSession(threadId);
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
  // Récupère le threadId stocké dans les métadonnées de la dernière réponse de l'agent
  // (voir le `return` en fin de fonction). `String(contexte.history[0])` — utilisé
  // auparavant — retournait "[object Object]" pour TOUTES les conversations (un
  // ChatRequestTurn n'a pas de toString() utile), ce qui faisait partager la même
  // session à toutes les discussions Copilot ouvertes en parallèle.
  let threadId: string | undefined;
  for (let i = contexte.history.length - 1; i >= 0; i--) {
    const tour = contexte.history[i];
    if (tour instanceof vscode.ChatResponseTurn) {
      const idTrouve = (tour.result?.metadata as { experdeployThreadId?: string } | undefined)
        ?.experdeployThreadId;
      if (typeof idTrouve === "string") {
        threadId = idTrouve;
        break;
      }
    }
  }
  threadId ??= `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Purge défensive : évite que `sessions` grossisse indéfiniment sur une session VS Code
  // longue durée (chaque nouvelle conversation Copilot crée un threadId inédit).
  const LIMITE_SESSIONS = 50;
  if (sessions.size >= LIMITE_SESSIONS) {
    const plusAncien = sessions.keys().next().value;
    if (plusAncien) {
      sessions.delete(plusAncien);
    }
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

      // ⚡ Raccourci : "init <vue|react|angular> <nom-du-projet>" scaffold directement,
      // sans passer par les étapes intermédiaires de choix du framework puis du nom.
      const raccourciInit = messageUtilisateur.match(
        /^init\s+(vue|react|angular)\s+(.+)$/i,
      );
      if (raccourciInit) {
        const frameworkRaccourci = raccourciInit[1].toLowerCase();
        const nomProjetRaccourci = raccourciInit[2].trim();
        session.frameworkChoisi = frameworkRaccourci;
        session.nomProjet = nomProjetRaccourci;
        stream.markdown(
          `⚡ **Raccourci détecté** — initialisation directe de \`${nomProjetRaccourci}\` (${frameworkRaccourci}), sans passer par les étapes intermédiaires.\n\n`,
        );
        lancerScaffold(
          stream,
          threadId,
          frameworkRaccourci,
          nomProjetRaccourci,
        );
        break;
      }

      if (messageNormalise === "1" || messageNormalise === "init") {
        session.etat = "INIT_CHOIX_FRAMEWORK";
        stream.markdown(`## 🏗️ Initialisation d'un nouveau projet

### Stack technique — Vue (par défaut)

| Couche | Technologie |
|--------|-------------|
| **Framework** | Vue 3.5 (\`<script setup lang="ts">\`) |
| **Build** | Vite 7 + vue-tsc |
| **État** | Pinia (setup stores) |
| **Routing** | vue-router 5 — \`createWebHashHistory\` |
| **UI** | shadcn-vue Vega + Tailwind CSS v4 |
| **URLs** | Relatives uniquement |

---

**Que souhaitez-vous faire ?**

| # | Choix |
|---|-------|
| **1** | Continuer avec Vue (stack par défaut) |
| **2** | Utiliser React à la place |
| **3** | Utiliser Angular à la place |
| **0** | Revenir au menu principal |

`);
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
        const environmentId = lireEnvironmentIdCodeApp();

        stream.markdown(`▶️ **Lancement du serveur de développement Code App...**

`);
        if (localAppUrlMisAJour) {
          stream.markdown(
            `> 🔧 Framework détecté : **${framework}** — \`localAppUrl\` mis à jour → \`http://localhost:${portDev}\` dans \`power.config.json\`\n\n`,
          );
        }

        // NOTE (2026-07-16) : deux terminaux DISTINCTS.
        // Terminal 1 (App) : `npm run dev` — DOIT démarrer en premier pour que le port
        // local soit à l'écoute avant que le proxy Power Apps ne tente de le tunneler.
        // Terminal 2 (Proxy) : attend en TCP que le port local réponde, PUIS lance
        // `npx power-apps run`. Sans ce garde-fou, le proxy sortait en erreur
        // "app can not be found" parce que Vite n'était pas encore prêt.
        //
        // `pac auth create --deviceCode` a été RETIRÉ ici : il polluait `pac auth list`
        // avec un nouveau profil à chaque `run`, et bloquait le flux en mode interactif.
        // `pac env select --environment <id>` suffit à aligner le contexte pac sur le bon
        // env avant que `power-apps run` s'en serve, et échoue clairement si non authentifié.
        if (environmentId) {
          stream.markdown(
            `> 🔐 Alignement du contexte pac sur l'environnement \`${environmentId}\`.\n\n`,
          );
        } else {
          stream.markdown(
            "> ⚠️ Aucun `environmentId` détecté dans `power.config.json` — initialisez d'abord le projet (`codeapp` puis `initialiser`) si ce n'est pas déjà fait.\n\n",
          );
        }

        // --- Terminal 1 : serveur local ---
        const terminalApp = obtenirOuCreerTerminalNomme(NOM_TERMINAL_APP);
        terminalApp.show(true);
        if (environmentId) {
          terminalApp.sendText(`pac env select --environment "${environmentId}"`);
        }
        terminalApp.sendText("npm run dev");

        // --- Terminal 2 : proxy Power Apps, avec attente TCP sur le port local ---
        // Timeout : 60 * 500ms = 30 secondes, largement de quoi laisser Vite/Angular démarrer.
        // Test TCP via TcpClient : plus rapide et plus fiable que Test-NetConnection.
        const scriptAttenteEtProxy = [
          `Write-Host "⏳ Attente du serveur local sur le port ${portDev}..." -ForegroundColor Cyan`,
          `$experdeployPret = $false`,
          `for ($i = 0; $i -lt 60; $i++) { try { $tcp = [Net.Sockets.TcpClient]::new('localhost', ${portDev}); $tcp.Close(); $experdeployPret = $true; break } catch { Start-Sleep -Milliseconds 500 } }`,
          `if ($experdeployPret) { Write-Host "✅ Serveur local détecté sur ${portDev} — lancement du proxy Power Apps." -ForegroundColor Green } else { Write-Host "⚠️ Serveur local non détecté après 30s — lancement du proxy quand même, mais le lien risque d'échouer." -ForegroundColor Yellow }`,
          `npx power-apps run`,
        ].join("; ");
        const terminalProxy = obtenirOuCreerTerminalNomme(NOM_TERMINAL_PROXY);
        // false → ne vole pas le focus du terminal 1, l'utilisateur voit vite démarrer d'abord.
        terminalProxy.show(false);
        terminalProxy.sendText(scriptAttenteEtProxy);

        stream.markdown(`> ℹ️ Deux terminaux sont ouverts : **${NOM_TERMINAL_APP}** (Vite/Angular) et **${NOM_TERMINAL_PROXY}** (proxy Power Apps, démarre automatiquement dès que le port ${portDev} répond).

> ⚠️ **Si le message _"NOT currently running"_ persiste après 30 secondes**, vérifiez que votre config expose bien le port ${portDev} :
> \`\`\`js
> export default { server: { port: ${portDev} } }
> \`\`\`

> ❓ **Si le lien navigateur renvoie "app can not be found"** :
> 1. \`appId\` obsolète dans \`power.config.json\` → lancez un **\`push\` (menu 4)**, il purge l'\`appId\` cassé et régénère.
> 2. Profil pac connecté sur un autre tenant/env que celui du projet → menu **\`connexion\` (5)** pour aligner.
> 3. Auth expirée → \`pac auth create --environment <id> --deviceCode\` manuellement dans un des terminaux.

`);
        ouvrirNavigateurServeur(stream);
        reinitialiserSession(threadId);
        break;
      }

      if (messageNormalise === "4" || messageNormalise === "push") {
        session.etat = "CODE_APP_PUSH_CONFIRM";
        stream.markdown(`## ⬆️ Push du Code App vers Dataverse

> Cette opération va **compiler le projet** (\`npm run build\`) puis **pousser le code** vers votre environnement Power Platform via \`npx power-apps push\`.

**Confirmez-vous le push ?**

> Répondez **oui** pour lancer le push, ou **non** pour revenir au menu principal.
`);
        break;
      }

      if (messageNormalise === "5" || messageNormalise === "connexion") {
        session.etat = "CONNEXION_CHOIX_COMPTE";
        afficherMenuConnexion(stream);
        break;
      }

      if (
        messageNormalise === "6" ||
        messageNormalise === "maj" ||
        messageNormalise === "update"
      ) {
        session.etat = "MAJ_CONFIRM";
        stream.markdown(`## ⬇️ **Mise à jour d'ExperteesDeploy**

> Cette opération va télécharger la dernière release GitHub (\`experdeploy.vsix\`) et réinstaller l'extension dans VS Code, en écrasant la version actuelle.

**Confirmez-vous la mise à jour ?**

> Répondez **oui** pour lancer la mise à jour, ou **non** pour revenir au menu principal.
`);
        break;
      }

      stream.markdown("❓ Choix non reconnu.\n\n");
      afficherMenuPrincipal(stream);
      break;
    }

    // --- MISE À JOUR DE L'EXTENSION : CONFIRMATION ---
    case "MAJ_CONFIRM": {
      if (
        messageNormalise === "oui" ||
        messageNormalise === "o" ||
        messageNormalise === "yes" ||
        messageNormalise === "y"
      ) {
        stream.markdown(
          "> Téléchargement de la dernière release GitHub et réinstallation de l'extension dans le terminal...\n\n",
        );
        executerScriptSecurise([
          '$domain = "github.com"',
          '$path = "Atom-CG/ExperteesDeployAgent/releases/latest/download/experdeploy.vsix"',
          'Invoke-WebRequest -Uri "https://$domain/$path" -OutFile "$env:TEMP\\experdeploy.vsix"',
          'code --install-extension "$env:TEMP\\experdeploy.vsix" --force',
          'Remove-Item "$env:TEMP\\experdeploy.vsix"',
        ]);
        session.etat = "MAJ_RELOAD_CONFIRM";
        stream.markdown(`> ⚠️ **Attendez la fin de l'installation dans le terminal** (message final \`Extension 'Atom-CG.expertees-deploy' v1.x.x was successfully installed\`) **AVANT de répondre ci-dessous**, sinon l'installation risque d'être corrompue.

---

**Souhaitez-vous recharger VS Code automatiquement une fois l'installation terminée ?**

> **oui** — recharge la fenêtre (\`Developer: Reload Window\`) pour activer la nouvelle version. La conversation Copilot Chat actuelle sera fermée mais l'historique reste conservé.
> **non** — vous rechargerez manuellement plus tard via \`Ctrl+Shift+P\` → \`Developer: Reload Window\`.
`);
        break;
      }

      if (
        messageNormalise === "non" ||
        messageNormalise === "n" ||
        messageNormalise === "no" ||
        messageNormalise === "menu" ||
        messageNormalise === "retour"
      ) {
        stream.markdown("↩️ Mise à jour annulée. Retour au menu principal.\n\n");
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      stream.markdown(
        "❓ Répondez **oui** pour lancer la mise à jour, ou **non** pour revenir au menu.\n",
      );
      break;
    }

    // --- MISE À JOUR DE L'EXTENSION : RELOAD AUTOMATIQUE ---
    case "MAJ_RELOAD_CONFIRM": {
      if (
        messageNormalise === "oui" ||
        messageNormalise === "o" ||
        messageNormalise === "yes" ||
        messageNormalise === "y"
      ) {
        stream.markdown(
          "🔄 **Rechargement de la fenêtre VS Code...** À dans quelques secondes !\n",
        );
        reinitialiserSession(threadId);
        // reloadWindow tue le process courant → pas besoin d'await, l'extension host redémarre.
        // NOTE : commande VS Code officielle et publique, utilisée par les extension packs Microsoft.
        vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      }

      if (
        messageNormalise === "non" ||
        messageNormalise === "n" ||
        messageNormalise === "no" ||
        messageNormalise === "menu" ||
        messageNormalise === "retour"
      ) {
        stream.markdown(`↩️ Pas de rechargement automatique.

> Pour activer la nouvelle version quand vous êtes prêt : \`Ctrl+Shift+P\` → **Developer: Reload Window**.

`);
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      stream.markdown(
        "❓ Répondez **oui** pour recharger VS Code, ou **non** pour le faire manuellement plus tard.\n",
      );
      break;
    }

    // --- PHASE INIT PROJET : CHOIX DU FRAMEWORK ---
    case "INIT_CHOIX_FRAMEWORK": {
      if (!messageUtilisateur) {
        break;
      }

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
    case "INIT_NOM_PROJET": {
      if (!messageUtilisateur) {
        break;
      }
      session.nomProjet = messageUtilisateur.trim();
      const framework = session.frameworkChoisi || "vue";
      lancerScaffold(stream, threadId, framework, session.nomProjet);
      break;
    }

    // --- PHASE CODE APP ---
    case "CODE_APP_PUSH_CONFIRM": {
      if (
        messageNormalise === "oui" ||
        messageNormalise === "o" ||
        messageNormalise === "yes"
      ) {
        await lancerPushCodeApp(stream, threadId);
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
        afficherPromptEnvironnementCodeApp(stream);
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
        afficherPromptEnvironnementCodeApp(stream);
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
        stream.markdown(`## ➕ **Ajout d'un nouveau compte**

> Un **popup navigateur** va s'ouvrir automatiquement pour vous authentifier sur Microsoft Entra ID (SSO utilisé si disponible).

`);
        // NOTE (2026-07-16) : `--deviceCode` retiré → flow interactif direct (popup WAM sur
        // Windows / navigateur système avec callback localhost sur Mac/Linux). Fallback
        // manuel possible via `pac auth create --deviceCode` si l'environnement le bloque.
        executerDansTerminal("pac auth create");
        stream.markdown(`---

> ℹ️ Si le popup ne s'ouvre pas (env corporate, WSL, session distante) : tapez \`pac auth create --deviceCode\` manuellement dans le terminal pour repasser au device code flow.

Une fois l'authentification terminée dans le navigateur, tapez **suite** pour voir la liste des environnements disponibles.
`);
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
        stream.markdown(`---

**Quel environnement souhaitez-vous utiliser ?**

> Tapez l'**URL** ou l'**ID** de l'environnement (visible dans le terminal), ou \`menu\` pour revenir.
`);
        break;
      }

      // --- Suppression d'une connexion sauvegardée ---
      const matchDel = messageUtilisateur.trim().match(/^del\s+(.+)$/i);
      if (matchDel) {
        const aliasCible = matchDel[1].trim();
        if (supprimerConnexion(aliasCible)) {
          stream.markdown(
            `🗑️ Connexion \`${aliasCible}\` supprimée de \`.experdeploy.json\`.\n\n`,
          );
        } else {
          stream.markdown(
            `⚠️ Aucune connexion nommée \`${aliasCible}\` à supprimer.\n\n`,
          );
        }
        afficherMenuConnexion(stream);
        break;
      }

      // --- Application d'une connexion sauvegardée par son alias ---
      const connexion = trouverConnexionParAlias(messageUtilisateur.trim());
      if (connexion) {
        session.compteIndex = connexion.compteIndex;
        session.environnementSelectionne = connexion.environnementUrl;
        stream.markdown(`## ♻️ Application de la connexion sauvegardée **\`${connexion.alias}\`**

> Compte pac #${connexion.compteIndex} → \`${connexion.environnementUrl}\`

`);
        executerScriptSecurise([
          `pac auth select --index ${connexion.compteIndex}`,
          `pac env select --environment "${connexion.environnementUrl}"`,
          `Write-Host "✅ Connexion '${connexion.alias.replace(/'/g, "''")}' appliquée." -ForegroundColor Green`,
        ]);
        // Mémoriser aussi dans power.config.json pour que codeapp/run le réutilisent
        sauvegarderEnvironnementDansConfig(connexion.environnementUrl);
        stream.markdown(
          "> 💾 Environnement propagé dans `power.config.json`.\n\n---\n\n↩️ Retour au menu principal.\n",
        );
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }

      stream.markdown(
        "❓ Saisie non reconnue. Tapez un **numéro de compte pac**, un **alias sauvegardé**, `0` pour ajouter un compte, `del <alias>` pour supprimer, ou `menu`.\n",
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
        stream.markdown(`---

**Quel environnement souhaitez-vous utiliser ?**

> Tapez l'**URL** ou l'**ID** de l'environnement (visible dans le terminal), ou \`menu\` pour revenir.
`);
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

      if (!messageUtilisateur) {
        break;
      }

      const envChoisi = messageUtilisateur.trim();
      session.environnementSelectionne = envChoisi;

      stream.markdown(`## 🌍 **Sélection de l'environnement**

> Environnement choisi : \`${envChoisi}\`

`);

      executerScriptSecurise([
        `pac env select --environment "${envChoisi}"`,
        `Write-Host "✅ Environnement sélectionné avec succès !" -ForegroundColor Green`,
      ]);

      const sauvegarde = sauvegarderEnvironnementDansConfig(envChoisi);
      stream.markdown(
        sauvegarde
          ? "> 💾 Environnement sauvegardé dans `power.config.json`.\n\n"
          : "> ℹ️ Aucun fichier `power.config.json` trouvé — l'environnement n'a pas été sauvegardé localement.\n\n",
      );

      // Propose la sauvegarde de cette combinaison (compte + env) comme préréglage
      // réutilisable via un alias, à condition qu'un workspace soit ouvert.
      if (cheminConfigExperdeploy() && session.compteIndex > 0) {
        session.etat = "CONNEXION_SAUV_PROPOSITION";
        stream.markdown(`---

**Souhaitez-vous sauvegarder cette connexion (compte pac #${session.compteIndex} + \`${envChoisi}\`) comme préréglage rapide ?**

> Répondez **oui** pour lui donner un alias, ou **non** pour revenir au menu principal.
`);
        break;
      }

      stream.markdown(
        "---\n\n✅ **Connexion et environnement configurés.** Retour au menu principal.\n\n",
      );
      reinitialiserSession(threadId);
      afficherMenuPrincipal(stream);
      break;
    }

    // --- CONNEXION : PROPOSITION DE SAUVEGARDE ---
    case "CONNEXION_SAUV_PROPOSITION": {
      if (messageNormalise === "oui" || messageNormalise === "o" || messageNormalise === "yes") {
        session.etat = "CONNEXION_SAUV_ALIAS";
        stream.markdown(`## 💾 Sauvegarde de la connexion

Sous quel **alias** ? (lettres, chiffres, \`.\`, \`_\`, \`-\` — max 32 caractères)

> _Ex : \`client-A-dev\`, \`prod\`, \`sandbox\`_
> Si l'alias existe déjà, il sera **remplacé**. Tapez \`menu\` pour annuler.
`);
        break;
      }
      if (messageNormalise === "non" || messageNormalise === "n" || messageNormalise === "no" || messageNormalise === "menu") {
        stream.markdown("↩️ Sauvegarde ignorée. Retour au menu principal.\n\n");
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }
      stream.markdown("❓ Répondez **oui** pour sauvegarder, ou **non** pour revenir au menu.\n");
      break;
    }

    // --- CONNEXION : SAISIE DE L'ALIAS ---
    case "CONNEXION_SAUV_ALIAS": {
      if (messageNormalise === "menu" || messageNormalise === "retour") {
        reinitialiserSession(threadId);
        afficherMenuPrincipal(stream);
        break;
      }
      const alias = messageUtilisateur.trim();
      if (!ALIAS_VALIDE.test(alias)) {
        stream.markdown(
          "❌ Alias invalide. Utilisez uniquement lettres, chiffres, `.`, `_`, `-` (max 32 caractères).\n",
        );
        break;
      }
      const ok = sauvegarderConnexion({
        alias,
        compteIndex: session.compteIndex,
        environnementUrl: session.environnementSelectionne,
      });
      stream.markdown(
        ok
          ? `✅ Connexion sauvegardée dans \`.experdeploy.json\` sous l'alias **\`${alias}\`**.

> Prochainement, tapez simplement \`${alias}\` dans le menu **connexion** pour la ré-appliquer.

`
          : "⚠️ Impossible d'écrire dans `.experdeploy.json`. Vérifiez les droits du dossier.\n\n",
      );
      reinitialiserSession(threadId);
      afficherMenuPrincipal(stream);
      break;
    }

    case "CODE_APP_INIT_ENV": {
      let envId = messageUtilisateur.trim();
      if (!envId) {
        const envSauvegarde = lireEnvironnementSauvegarde();
        if (!envSauvegarde) {
          break;
        }
        envId = envSauvegarde;
        stream.markdown(
          `> ♻️ Réutilisation de l'environnement précédent : \`${envId}\`\n\n`,
        );
      }
      stream.markdown(`## ⚙️ Configuration du projet en Code App

🌍 ID d'environnement : **${envId}**

### Étapes lancées dans le terminal :
1. 🔐 Authentification Power Platform — **un popup navigateur va s'ouvrir automatiquement** pour la connexion (Microsoft Entra ID)
2. 📦 Installation du SDK **@microsoft/power-apps**
3. 🔧 Initialisation du projet Code App

> ✅ Validez la connexion dans le popup, puis suivez les instructions dans le terminal. Une fois terminé, utilisez **3** (\`run\`) pour démarrer le serveur local.

> ℹ️ Si le popup ne s'ouvre pas (environnement corporate qui bloque le callback \`localhost\`, WSL, session distante) : \`pac auth create --environment "${envId}" --deviceCode\` manuellement dans le terminal pour repasser au device code flow.

`);

      // NOTE (2026-07-16) : `npx power-apps init` gère sa PROPRE session
      // d'authentification/son PROPRE cache de token MSAL (fichier
      // %LOCALAPPDATA%\.IdentityService\msal.cache), complètement distinct de celui de
      // `pac` — un `pac auth create` (même interactif, même réussi) NE rafraîchit PAS ce
      // cache. Symptôme observé en usage réel : AADSTS70043 (refresh token expiré par une
      // politique de fréquence de connexion / conditional access) qui persiste à
      // l'identique après un `pac auth create` pourtant réussi entre-deux, car
      // `power-apps init` retente avec son propre vieux token en cache.
      //
      // Le fix utilise la commande OFFICIELLE `power-apps logout` (confirmée via
      // `power-apps --help` — "Clear all cached credentials. Removes every cached account
      // and the active-account pointer.") plutôt qu'une suppression manuelle du fichier de
      // cache : plus robuste si Microsoft fait évoluer le format/emplacement du cache.
      // Après `logout`, le cache étant vide, `npx power-apps init` redéclenche
      // automatiquement son propre flux de login navigateur — pas besoin d'appeler
      // `power-apps login` explicitement.
      const commandeInitAvecRetryAuth = [
        `Write-Host "🔧 Initialisation du projet Code App..." -ForegroundColor Cyan`,
        `$global:LASTEXITCODE = 0`,
        `npx power-apps init`,
        `if ($LASTEXITCODE -ne 0) { Write-Host "⚠️ Échec probable dû à une session expirée. Déconnexion et nouvelle authentification (popup navigateur)..." -ForegroundColor Yellow; npx power-apps logout; pac auth create --environment "${envId}"; $global:LASTEXITCODE = 0; npx power-apps init; if ($LASTEXITCODE -ne 0) { Write-Host "❌ Échec persistant après déconnexion et réauthentification. Vérifiez manuellement votre connexion (menu 5) puis relancez l'initialisation." -ForegroundColor Red } }`,
      ].join("; ");

      const commandesCodeApp = [
        `Write-Host "🔐 Authentification Power Platform (popup navigateur)..." -ForegroundColor Cyan`,
        // NOTE (2026-07-16) : `--deviceCode` RETIRÉ.
        // Sans ce flag, `pac auth create` bascule en flow interactif : sur Windows un popup
        // WAM (Web Account Manager) natif s'ouvre — ou à défaut le navigateur système avec
        // callback localhost — au lieu d'imposer le "va sur microsoft.com/devicelogin et
        // tape ce code" du device flow. UX beaucoup plus fluide, surtout avec SSO actif.
        // En cas d'échec (env corporate qui bloque le callback localhost, WSL, etc.),
        // relancer manuellement `pac auth create --environment "${envId}" --deviceCode`.
        `pac auth create --environment "${envId}"`,
        `Write-Host "📦 Installation du SDK @microsoft/power-apps..." -ForegroundColor Cyan`,
        `npm install @microsoft/power-apps`,
        commandeInitAvecRetryAuth,
        `Write-Host "✅ Projet initialisé avec succès !" -ForegroundColor Green`,
      ];
      // NOTE (2026-07-10) : `executerAvecAutoReauth` (basé sur l'API Shell Integration)
      // a été retiré — il restait bloqué indéfiniment dans certains environnements, y
      // compris sur un simple `Write-Host` (aucune commande suivante n'était jamais
      // envoyée), alors que la même commande fonctionne normalement dans un terminal
      // classique. `executerScriptSecurise` (sendText, identique à une saisie manuelle)
      // reste utilisé ici ; c'est le contenu de `commandeInitAvecRetryAuth` (script
      // PowerShell auto-suffisant, sans dépendance à un événement VS Code) qui gère
      // désormais la reconnexion automatique ET la déconnexion propre du cache
      // `power-apps` en cas d'échec de `npx power-apps init`.
      executerScriptSecurise(commandesCodeApp);

      reinitialiserSession(threadId);
      break;
    }
  }

  return { metadata: { experdeployThreadId: threadId } };
}

function afficherMenuPrincipal(stream: vscode.ChatResponseStream): void {
  stream.markdown(`# 🚀 Bienvenue sur **ExperteesDeploy**

> Votre assistant de déploiement Power Platform. Il vous guide pas à pas pour scaffolder, configurer et déployer vos Code Apps et solutions Dataverse, directement depuis VS Code.

---

## Menu principal

| # | Action | Description |
|---|--------|-------------|
| **1** | \`init\` | Initialiser un projet front-end (Vue · React · Angular) |
| **2** | \`codeapp\` | Transformer le projet en Power Apps Code App |
| **3** | \`run\` | Démarrer le serveur local (connexion maintenue) |
| **4** | \`push\` | Pousser le Code App (Inner-loop) |
| **5** | \`connexion\` | Gérer la connexion et sélectionner l'environnement Power Platform |
| **6** | \`maj\` | Mettre à jour l'extension ExperDeploy vers la dernière version |

`);
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