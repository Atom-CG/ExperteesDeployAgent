# 🚀 ExperDeploy

ExperDeploy est un **Chat Participant pour GitHub Copilot (VS Code)** conçu pour simplifier, guider et automatiser le cycle de vie de vos projets Power Apps Code App (Code First) et la gestion de vos environnements Power Platform.

Grâce à une machine d'état conversationnelle séquentielle et une interaction directe avec le terminal VS Code, il accompagne les développeurs pas à pas via un menu interactif, limitant ainsi le risque d'erreur humaine lors des phases critiques (authentification, run local, push et déploiement).

---

## ✨ Fonctionnalités clés

* **Scaffolding de projets Front-End :** Initialise en un clic un nouveau projet basé sur la stack Expertime (Vue 3.5 par défaut avec Vite 7, Pinia, shadcn-vue et Tailwind CSS v4), ou alternativement avec React 19 ou Angular 19.
* **Configuration guidée Power Apps Code App :** Analyse et valide les prérequis (Node.js, Git, extensions VS Code), installe le SDK `@microsoft/power-apps` et initialise votre projet pour le lier à Dataverse.
* **Gestion automatisée de l'Inner-Loop (`run` & `push`) :** 
  * Détecte automatiquement le port de votre serveur de développement local (Vite, Next, Angular, etc.) et met à jour dynamiquement le fichier `power.config.json`.
  * Lance simultanément votre serveur local et le proxy Power Apps (`npm run dev & npx power-apps run`) puis ouvre automatiquement votre navigateur.
  * Automatise la compilation (`npm run build`) et le push vers Dataverse, avec détection et correction automatique des erreurs courantes (comme la suppression d'un `appId` obsolète).
* **Gestion des connexions & environnements :** Permet de lister, d'ajouter (via authentification MFA dans le navigateur) et de basculer entre vos différents profils et environnements Power Platform (`pac auth` et `pac env`).
* **Intégration transparente :** Accessible directement depuis l'interface de GitHub Copilot Chat via le tag dédié.

---

## 📦 Installation

Ce projet est une extension VS Code complète (`.vsix`). Pour l'installer instantanément sur votre poste sans passer par le Marketplace public, ouvrez un terminal **PowerShell** et exécutez la commande unique suivante :

```powershell
Invoke-WebRequest -Uri "[https://github.com/Atom-CG/ExperteesDeployAgent/releases/latest/download/experdeploy.vsix](https://github.com/Atom-CG/ExperteesDeployAgent/releases/latest/download/experdeploy.vsix)" -OutFile "$env:TEMP\experdeploy.vsix"; code --install-extension "$env:TEMP\experdeploy.vsix"; Remove-Item "$env:TEMP\experdeploy.vsix"