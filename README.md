# 🚀 ExperDeploy

ExperDeploy est un **Chat Participant pour GitHub Copilot (VS Code)** conçu pour industrialiser, automatiser et sécuriser la gestion de vos environnements et vos workflows de déploiement. 

Grâce à une machine d'état conversationnelle et une intégration profonde avec le terminal VS Code, il accompagne les développeurs pas à pas dans l'exécution de leurs tâches DevOps, en limitant drastiquement le risque d'erreur humaine.

## ✨ Fonctionnalités clés

* **Pilotage intelligent du terminal :** Génère, valide et exécute les commandes CLI (ex: `pac cli` pour Power Platform) directement dans votre espace de travail.
* **Machine d'état contextuelle :** Suit l'état de votre déploiement étape par étape, garantissant que les prérequis sont validés avant toute action critique.
* **Sécurisation des environnements :** Vérifie systématiquement les jetons d'authentification et l'environnement actif avant de lancer un déploiement.
* **Intégration transparente :** Accessible directement depuis l'interface de GitHub Copilot Chat via le tag `@experdeploy`.

## 📦 Installation & Intégration

Ce projet est une extension VS Code complète (`.vsix`). Pour l'intégrer automatiquement à vos projets d'équipe, ajoutez-la aux recommandations de votre workspace :

```powershell
Invoke-WebRequest -Uri "https://github.com/Atom-CG/ExperteesDeployAgent/releases/latest/download/experdeploy.vsix" -OutFile "$env:TEMP\experdeploy.vsix"; code --install-extension "$env:TEMP\experdeploy.vsix"; Remove-Item "$env:TEMP\experdeploy.vsix"
```

