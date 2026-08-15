# Workflow de développement

Ce document décrit comment le code passe d'une idée à une version installée chez
l'utilisateur.

---

## Les branches

| Branche | Rôle |
|---|---|
| `main` | **Production.** Ce qui est publié aux utilisateurs. Ne reçoit que du code vérifié. |
| `dev` | **Intégration.** Là où le travail s'accumule et se stabilise. |
| `feat/…`, `fix/…` | Une branche par changement, partant de `dev`. |

Règle simple : **on ne pousse jamais directement sur `main`.** Tout y arrive par
fusion depuis `dev`, et seulement quand ça fonctionne.

```
feat/mon-truc ──▶ dev ──▶ main ──▶ tag vX.Y.Z ──▶ release ──▶ auto-update
```

### Au quotidien

```bash
git checkout dev
git pull

git checkout -b feat/nom-du-changement
# … travail …
npm run test:all          # suite complète, y compris les tests graphiques
git commit
git push -u origin feat/nom-du-changement
```

Ouvrir une pull request **vers `dev`**. La CI vérifie le typage, la
correspondance floue et le packaging. Une fois verte et le comportement validé en
jeu, fusionner.

Quand `dev` est stable et qu'on veut livrer :

```bash
git checkout main
git merge --no-ff dev
git push
```

---

## Publier une version

La release est un **acte délibéré**, déclenché par un tag — jamais automatique à
la fusion. Publier à chaque merge imposerait un téléchargement à l'utilisateur
pour n'importe quel correctif de commentaire.

Depuis `main`, à jour et propre :

```bash
npm run release:patch     # 1.0.0 -> 1.0.1  (correctif)
npm run release:minor     # 1.0.0 -> 1.1.0  (fonctionnalité)
npm run release:major     # 1.0.0 -> 2.0.0  (rupture)

git push --follow-tags
```

`npm version` incrémente `package.json`, crée le commit et le tag en une fois —
c'est ce qui garantit qu'ils ne divergent jamais. Le workflow `release.yml`
prend le relais : il **refuse de publier si le tag ne correspond pas à
`package.json`**, parce que l'incohérence serait autrement silencieuse et
produirait un `latest.yml` annonçant une version introuvable.

Le workflow compile, empaquete l'installeur NSIS, puis téléverse sur la release
GitHub :

- `TarkovPriceHover-Setup-X.Y.Z.exe` — l'installeur ;
- `latest.yml` — **le fichier que lit l'updater.** Sans lui, une release existe
  mais reste invisible pour les applications déjà installées.

---

## Ce que la CI vérifie, et ce qu'elle ne peut pas vérifier

| Vérification | CI | Local |
|---|---|---|
| Typage (`npm run typecheck`) | ✅ | ✅ |
| Correspondance floue (`test:match`) | ✅ | ✅ |
| Compilation + packaging | ✅ | ✅ |
| OCR (`test:ocr`) | ❌ | ✅ |
| Cadrage (`test:region`) | ❌ | ✅ |
| Grille (`test:grid`) | ❌ | ✅ |

Les trois derniers pilotent une **vraie session graphique** : ils capturent
l'écran via Electron. Un agent GitHub n'a pas de bureau exploitable, et ces tests
y échoueraient pour une raison sans rapport avec le code. Un pipeline rouge en
permanence n'apprend qu'une chose : à l'ignorer.

D'où la règle : **`npm run test:all` avant de pousser.** C'est le seul endroit où
la chaîne complète est réellement éprouvée.

---

## Comment la mise à jour parvient à l'utilisateur

1. L'application vérifie 20 s après le démarrage, puis toutes les 4 heures.
2. Si une version supérieure existe dans `latest.yml`, elle est **téléchargée en
   arrière-plan**, sans rien demander.
3. Une fois prête, elle **attend la fermeture de l'application** pour s'installer.

Ce dernier point est délibéré : un redémarrage imposé en plein raid serait pire
que pas de mise à jour du tout. L'utilisateur peut forcer l'installation
immédiatement depuis le tray ou l'onglet Général.

En développement, le mécanisme se met en sommeil et l'affiche : `app-update.yml`
n'est généré qu'au packaging, et son absence n'est pas une panne.

### Vérifier une release avant de la diffuser

`npm run dist` produit l'installeur dans `release/` sans rien publier. Installer
cette version, puis publier une release supérieure, permet de constater le cycle
complet de mise à jour sur sa propre machine.
