# Tarkov Price Hover

Overlay Windows qui affiche le prix d'un objet d'*Escape from Tarkov* quand la souris
s'arrête dessus — dans le stash, l'inventaire en raid, le loot, les caisses.

```
┌──────────────────────────────────────┐
│ ▌ [icone]  LEDX Skin Transilluminator│
│            LEDX   1x1                │
│ ─────────────────────────────────────│
│ Flea 24h                   842 350 ₽ │
│ Dernier bas                810 000 ₽ │
│ Therapist                   58 741 ₽ │
│ Par slot                   842 350 ₽ │
│ ─────────────────────────────────────│
│ Flea vs trader +783 609 ₽   match 97%│
└──────────────────────────────────────┘
```

---

## ⚠ À lire avant tout

- **Usage strictement personnel.** Ce dépôt n'est pas destiné à la distribution.
- **Aucune garantie anti-ban.** Battlestate Games ne publie pas de liste blanche
  d'outils tiers. L'outil a été conçu pour rester le plus loin possible de tout ce
  qui ressemble à de la triche (voir [Posture vis-à-vis de BSG](#posture-vis-à-vis-de-bsg)),
  mais **vous l'utilisez à vos risques**.
- Ce que l'outil **ne fait pas**, par conception : aucune lecture de la mémoire du
  jeu, aucune injection, aucun hook, aucune modification de fichier du jeu, aucune
  interception réseau, aucune automatisation d'entrée. Il ne connaît même pas
  l'existence du processus Tarkov, hormis pour lire le nom de la fenêtre active.

---

## Sommaire

- [Comment ça marche](#comment-ça-marche)
- [Choix techniques](#choix-techniques)
- [Installation](#installation)
- [Premier lancement et calibration](#premier-lancement-et-calibration)
- [Utilisation](#utilisation)
- [Configuration](#configuration)
- [Architecture du code](#architecture-du-code)
- [Performances](#performances)
- [Tests](#tests)
- [Dépannage](#dépannage)
- [Limites connues](#limites-connues)
- [Posture vis-à-vis de BSG](#posture-vis-à-vis-de-bsg)
- [Modifier le projet](#modifier-le-projet)

---

## Comment ça marche

```
  souris immobile      capture large       localisation        OCR
  sur un objet  ─────► autour du     ────► de l'infobulle ───► (Tesseract WASM)
                       curseur             (auto)                    │
                                                                     ▼
  carte affichée ◄──── prix en cache ◄──── correspondance floue ◄────┘
  près du curseur      (tarkov.dev)        sur le nom lu
```

1. Une boucle légère lit la position du curseur toutes les 60 ms.
2. Dès que le curseur s'immobilise (180 ms par défaut), une large fenêtre autour de
   lui est capturée.
3. **L'infobulle y est localisée automatiquement** — aucune zone à calibrer. Voir
   [Localisation automatique](#localisation-automatique-de-linfobulle).
4. Le rectangle trouvé est converti en niveaux de gris, agrandi 2×, séparé
   texte/fond par [seuillage d'Otsu](https://fr.wikipedia.org/wiki/M%C3%A9thode_d%27Otsu),
   puis inversé (Tesseract attend du texte sombre sur fond clair, Tarkov affiche
   l'inverse).
5. Tesseract lit le texte. Le résultat est bruité — c'est normal.
6. Une correspondance floue (inclusion + coefficient de Dice sur bigrammes)
   retrouve l'objet dans la liste tarkov.dev.
7. La carte de prix s'affiche à côté du curseur.

### Localisation automatique de l'infobulle

L'infobulle de Tarkov est le **seul élément à l'écran** qui réunit ces quatre
propriétés : un grand rectangle, plein, nettement plus sombre que la scène, et
ancré près du curseur. C'est ce faisceau qui est exploité, et non une position
apprise — Tarkov place l'infobulle au-dessus, en dessous, à gauche ou à droite du
curseur selon la place disponible.

1. La fenêtre de recherche est sous-échantillonnée par moyenne de blocs. Moyenner
   plutôt qu'échantillonner est délibéré : le texte clair se fond dans le fond
   sombre, si bien que l'infobulle apparaît comme une zone pleine et non comme un
   rectangle troué de lettres.
2. Une échelle de huit seuils, allant des pixels les plus sombres jusqu'à la médiane
   de la scène, est balayée. Aucune luminance absolue n'est supposée : seulement que
   l'infobulle est plus sombre que ce qui l'entoure. Chaque configuration de gamma a
   ainsi une chance d'isoler proprement la boîte.
3. Pour chaque seuil : masque « sombre », fermeture morphologique (rebouche les
   trous laissés par le texte), puis étiquetage en composantes connexes.
4. **Chaque composante est rognée** jusqu'à ce que ses quatre bords soient pleins.
5. Filtrage par taille, taux de remplissage et distance au curseur ; la meilleure
   candidate (aire × remplissage) l'emporte.

L'étape 4 n'est pas un raffinement : elle est indispensable. L'infobulle se
superpose à l'inventaire, donc ses bords **touchent forcément les icônes sombres
situées derrière**. Sans rognage, les composantes connexes fusionnent l'infobulle
avec ces icônes, le rectangle englobant déborde et le taux de remplissage s'effondre
— la boîte est rejetée alors qu'elle était parfaitement détectée. Le rognage retire
les appendices (couverture de bord faible) et laisse le corps rectangulaire intact.

Le taux de remplissage est aussi ce qui distingue l'infobulle des icônes d'objets :
une silhouette de fusil remplit ~40 % de son rectangle englobant, un panneau
d'interface plus de 80 %.

Ce mécanisme est validé par `npm run test:ocr`, qui reconstruit une scène
d'inventaire synthétique (grille, icônes sombres, étiquettes, barre latérale) et
vérifie le cadrage sur quatre placements d'infobulle plus un cas négatif.

> Le mode **zone fixe** reste disponible dans l'onglet Détection, comme filet de
> sécurité si la détection automatique échouait sur votre configuration.

### Pourquoi l'OCR, et pas autre chose

Le brief listait quatre pistes. Voici pourquoi celle-ci a été retenue.

| Piste | Verdict |
|---|---|
| **Overwolf Game Events API** | Écartée. Overwolf est bien la voie la plus « bénie » par les éditeurs, mais son intégration EFT n'expose que des événements de partie (début/fin de raid, mort, extraction). **Il n'existe aucun événement « objet survolé »** — l'information n'est tout simplement pas disponible. Adopter Overwolf aurait imposé son SDK et son processus de publication sans résoudre le problème. |
| **OCR de l'infobulle native** | **Retenue.** L'information voulue est déjà affichée à l'écran par le jeu lui-même. La lire est techniquement équivalent à faire une capture d'écran. Aucune interaction avec le processus du jeu. |
| **Position souris + capture locale + OCR** | C'est la même chose que ci-dessus — c'est ce qui est implémenté. |
| **UI Automation / accessibilité Windows** | Impossible. Tarkov est un jeu Unity qui dessine son interface dans un contexte graphique ; il n'expose aucun arbre d'accessibilité. `UIAutomation` ne voit qu'une fenêtre vide. |

La seule information lue hors capture d'écran est **le nom du processus de la fenêtre
active** (via `GetForegroundWindow`, API publique de l'interface Windows). Elle sert
uniquement à ne pas gaspiller du CPU quand Tarkov n'est pas à l'écran. C'est la même
information qu'affiche le Gestionnaire des tâches.

---

## Choix techniques

### Stack : Electron 43 + TypeScript + esbuild

**Pourquoi Electron plutôt que C# / WinUI 3 :**

- Le rendu d'une fenêtre transparente, sans cadre, always-on-top et transparente
  aux clics est natif et fiable dans Electron (`transparent`, `setIgnoreMouseEvents`,
  `setAlwaysOnTop(win, 'screen-saver')`). En WPF il faut passer par
  `WS_EX_LAYERED` / `WS_EX_TRANSPARENT` en P/Invoke.
- La capture d'écran multi-écrans avec gestion du facteur d'échelle est fournie par
  `desktopCapturer` + `screen`, sans dépendance native.
- Le style de la carte est du CSS : itérer sur le rendu prend quelques secondes.

**Pourquoi zéro dépendance native (point le plus important) :**

L'ensemble du projet ne dépend d'**aucun module compilé**. Pas de `node-gyp`, pas de
Visual Studio Build Tools, pas de `.node` à recompiler à chaque version d'Electron.
Concrètement :

| Besoin | Solution retenue | Alternative écartée |
|---|---|---|
| Capture d'écran | `desktopCapturer` (Electron) | `screenshot-desktop` (binaire externe) |
| Position du curseur | `screen.getCursorScreenPoint()` | `robotjs` (natif, souvent cassé) |
| Traitement d'image | JS pur sur buffer BGRA | `sharp` / `jimp` (natif / lourd) |
| OCR | `tesseract.js` (WASM) | `node-tesseract-ocr` (binaire système) |
| Fenêtre active | un processus PowerShell persistant | `active-win` (natif) |

Coût de ce choix : le traitement d'image est en JavaScript. Mesuré à ~3 ms pour une
zone de 520×120 px — négligeable devant les ~60 ms de l'OCR.

**Pourquoi pas React / Vue :**

L'overlay est une quinzaine de nœuds DOM fixes mis à jour quelques fois par seconde ;
la fenêtre de configuration est un formulaire. Un framework aurait ajouté du temps de
démarrage et de la mémoire résidente à un processus qui doit rester invisible pour le
jeu, sans rien simplifier. Les champs de configuration sont reliés par attributs
`data-config` / `data-region` / `data-hotkey` : ajouter un réglage coûte une ligne de
HTML et une entrée dans `AppConfig`.

**Bundler : esbuild.** Build complet en ~40 ms. `tsc` ne sert qu'au typage
(`npm run typecheck`).

---

## Installation

**Prérequis :** Windows 10/11, [Node.js](https://nodejs.org/) 20 ou plus.

```bash
git clone <ce-depot> tarkov-price-hover
cd tarkov-price-hover
npm install
```

> **npm 11+ bloque les scripts d'installation par défaut.** Si le lancement échoue
> avec `Cannot find module ... electron/dist`, le binaire Electron n'a pas été
> téléchargé. Corrigez ainsi :
>
> ```bash
> node node_modules/electron/install.js
> ```

Lancer :

```bash
npm start          # build + lancement
npm run dev        # idem, avec logs verbeux
```

L'application démarre **dans la zone de notification** (à côté de l'horloge). Aucune
fenêtre principale, aucune entrée dans la barre des tâches. Clic droit sur l'icône
pour le menu, double-clic pour la configuration.

### Empaqueter un exécutable

```bash
npm run dist       # installeur NSIS dans release/
npm run pack       # dossier non empaqueté, plus rapide à tester
```

---

## Premier lancement

**Aucune calibration n'est nécessaire.** Deux choses se passent au démarrage :

1. **Téléchargement des prix** (~5 Mo, quelques secondes). Sans réseau, la fenêtre de
   configuration s'ouvre avec l'alerte « aucun prix ».
2. **Téléchargement des données OCR** (`eng.traineddata`, ~4 Mo) au premier survol.
   C'est la seule fois où l'OCR a besoin d'Internet ; ensuite tout est en cache.

Lancez Tarkov **en plein écran fenêtré** (voir [Limites](#limites-connues)), survolez
un objet, laissez l'infobulle apparaître : la carte s'affiche.

### Vérifier ce que voit le détecteur

Utile uniquement si quelque chose ne fonctionne pas comme prévu :

1. `Ctrl+Shift+O` → onglet **Debug** → cochez *Mode debug*.
2. Dans Tarkov, placez le curseur sur un objet et laissez l'infobulle apparaître.
3. Alt-Tab vers la configuration, cliquez **Analyser maintenant**.

Deux images s'affichent :

- **Fenêtre de recherche** — la zone explorée autour du curseur. Si l'infobulle n'y
  apparaît pas, c'est qu'elle n'était pas affichée au moment de la capture (le plus
  souvent : le curseur a bougé pendant l'Alt-Tab).
- **Zone retenue** — le rectangle finalement isolé, tel que le reçoit Tesseract.

| Ce que vous voyez | Interprétation |
|---|---|
| Zone retenue = l'infobulle, texte net | tout va bien |
| « aucune infobulle détectée » alors qu'elle est dans la fenêtre de recherche | signalez-le : cadre trop clair ou trop petit sur votre configuration |
| Zone retenue = un autre panneau sombre | l'infobulle était absente ; le détecteur a pris le panneau le plus proche |
| Texte OCR correct mais aucun match | baissez `matchThreshold` à 0,55 |

Le champ **Texte OCR brut** doit contenir le nom de l'objet, même mal orthographié —
le moteur de correspondance tolère beaucoup de bruit (voir `npm run test:match`).

En dernier recours, l'onglet Détection permet de basculer sur une **zone fixe**
définie manuellement.

---

## Utilisation

| Raccourci | Action |
|---|---|
| `Ctrl+Shift+P` | activer / désactiver l'overlay |
| `Ctrl+Shift+D` | basculer le mode debug |
| `Ctrl+Shift+O` | ouvrir la configuration |

> `Ctrl+Shift+P` est aussi la palette de commandes de VS Code, et un raccourci
> fréquent de Discord/Steam. Le raccourci global le capte en priorité, y compris hors
> du jeu. Si ça vous gêne, changez-le dans l'onglet **Raccourcis**.

En partie : survolez un objet, laissez la souris immobile un court instant, la carte
apparaît **juste sous l'infobulle du jeu**. Elle disparaît dès que le curseur sort de
l'infobulle (plus 90 px de marge), ou après le délai d'auto-masquage (8 s).

La sortie est mesurée sur l'infobulle elle-même, pas sur un rayon autour du point de
détection : c'est le signal exact de « je ne survole plus cet objet ». Un rayon fixe
serait trop nerveux sur une grande infobulle et trop laxiste sur une petite.

> La carte est ancrée à l'infobulle, jamais au curseur, et sa propre surface est
> exclue de l'analyse. Ce n'est pas cosmétique : la carte est un grand rectangle
> sombre près du curseur — exactement le motif que cherche le détecteur. Si elle
> recouvrait l'infobulle, l'outil finirait par lire ses propres libellés.

**Lecture de la carte :**

- **Flea 24h** — prix moyen sur 24 h, la valeur de référence la plus stable.
- **Dernier bas** — dernière offre la plus basse observée ; volatile.
- **Ligne trader** — le libellé porte le nom du meilleur acheteur (`Therapist`,
  `Prapor`…) et la valeur son prix en roubles.
- **Par slot** — prix Flea divisé par le nombre de cases. Le critère qui compte pour
  décider quoi ramasser quand le sac est plein.
- **Flea vs trader** — vert : vendre au Flea rapporte plus ; rouge : le trader est
  meilleur (fréquent pour les objets de troc à faible demande).
- **match XX %** — confiance de la reconnaissance. Sous 80 %, l'indicateur passe en
  orange : vérifiez que le nom affiché est bien celui que vous survolez.

---

## Configuration

`config/config.example.json` documente chaque clé. Le fichier réellement utilisé est
créé au premier lancement dans :

```
%APPDATA%\tarkov-price-hover\config.json
```

Tout est modifiable depuis l'interface ; l'édition manuelle du fichier est possible
(les valeurs hors bornes sont ramenées dans leur intervalle au chargement, les clés
préfixées par `_` sont ignorées).

| Clé | Défaut | Rôle |
|---|---|---|
| `dataSource` | `auto` | `auto` (JSON puis GraphQL), `json`, ou `graphql`. |
| `gameMode` | `regular` | `regular` (PvP) ou `pve`. Les prix diffèrent réellement. |
| `refreshIntervalMinutes` | `12` | Période de rafraîchissement des prix (1–240). |
| `overlayEnabled` | `true` | État de l'overlay. |
| `clickThrough` | `true` | Les clics traversent l'overlay. **À laisser à `true` en partie.** |
| `debugMode` | `false` | Capture les images et active les logs détaillés. |
| `onlyWhenGameFocused` | `true` | N'analyse l'écran que si le jeu est au premier plan. |
| `gameProcessName` | `EscapeFromTarkov` | Nom du processus (sans `.exe`). |
| `captureMode` | `auto` | `auto` (infobulle localisée seule) ou `manual` (zone fixe). |
| `captureRegion` | large, centré | Rectangle analysé relatif au curseur. **Mode `manual` uniquement.** |
| `hoverSettleMs` | `120` | Immobilité requise avant analyse. |
| `minOcrIntervalMs` | `220` | Intervalle minimal entre deux OCR (garde-fou CPU). |
| `cursorMoveThresholdPx` | `6` | Déplacement considéré comme un mouvement réel. |
| `matchThreshold` | `0.68` | Score minimal accepté. Trop bas → faux positifs. |
| `minPriceFilter` | `0` | Masque les objets sous ce prix. `0` = désactivé. |
| `autoHideMs` | `8000` | Délai avant disparition de la carte. |
| `showIcon` | `true` | Affiche l'icône (nécessite le réseau). |
| `overlayOpacity` | `0.95` | Opacité de la carte (0,1–1). |
| `overlayScale` | auto | Échelle de la carte (0,6–2,5). **Déduite de la hauteur de l'écran au premier lancement** (1,35 en 1440p, 2 en 4K). |
| `hotkeys.*` | voir plus haut | Syntaxe d'accélérateur Electron. |

**Emplacements des données :**

| Chemin (`%APPDATA%\tarkov-price-hover\`) | Contenu |
|---|---|
| `config.json` | configuration |
| `cache/prices-regular.json`, `cache/prices-pve.json` | prix par mode de jeu |
| `tessdata/` | données de langue Tesseract |
| `logs/app.log` | journal (rotation à 2 Mo, un backup) |

---

## Architecture du code

```
tarkov-price-hover/
├── README.md
├── package.json
├── build.mjs                       bundler esbuild (main / preload / renderers)
├── assets/                         icônes, générées par scripts/make-icons.mjs
├── config/config.example.json      configuration d'exemple commentée
├── scripts/
│   ├── start.mjs                   lanceur (neutralise ELECTRON_RUN_AS_NODE)
│   ├── verify-api.mjs              diagnostic autonome de l'API tarkov.dev
│   └── make-icons.mjs              génère les PNG sans dépendance graphique
└── src/
    ├── main/
    │   ├── main.ts                 assemblage et cycle de vie
    │   ├── windows.ts              overlay + fenêtre de configuration
    │   ├── tray.ts                 zone de notification
    │   └── hotkeys.ts              raccourcis globaux
    ├── services/
    │   ├── TarkovJsonApi.ts        client JSON (source active)
    │   ├── TarkovApi.ts            client GraphQL (repli, hors service depuis 07/2026)
    │   ├── PriceCache.ts           cache disque, rafraîchissement, mode dégradé
    │   ├── ItemIndex.ts            correspondance floue + calcul du résumé de prix
    │   ├── TooltipLocator.ts       localisation automatique de l'infobulle
    │   ├── FrameGrabber.ts         flux de capture persistant (4× plus rapide)
    │   ├── ScreenCapture.ts        capture + cadrage + prétraitement Otsu
    │   ├── OcrEngine.ts            Tesseract (init paresseuse, file d'attente)
    │   ├── ItemDetector.ts         boucle de détection, budget CPU
    │   ├── ForegroundWatcher.ts    fenêtre active via PowerShell
    │   ├── ConfigStore.ts          config.json, validation, valeurs par défaut
    │   └── Logger.ts               journal fichier + console, rotation
    ├── preload/                    ponts contextBridge (surface fermée)
    ├── overlay/                    carte de prix (HTML/CSS/TS)
    ├── ui/                         fenêtre de configuration
    ├── tools/                      auto-tests (voir ci-dessous)
    └── types/                      contrats partagés + valeurs par défaut
```

### Sécurité des fenêtres

Les deux fenêtres tournent en `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`. Les preloads exposent une liste fermée de fonctions : un
renderer ne peut pas invoquer un canal IPC arbitraire. La CSP interdit tout script
distant ; l'overlay n'autorise que les images HTTPS (icônes tarkov.dev).

### Données : tarkov.dev

Deux APIs publiques de tarkov.dev, sans clé. **Par défaut : `auto`** — l'API JSON en
premier, GraphQL en repli.

#### Pourquoi l'API JSON et non GraphQL

L'API GraphQL `api.tarkov.dev/graphql` **est hors service depuis le 21/07/2026**
([the-hideout/tarkov-api#474](https://github.com/the-hideout/tarkov-api/issues/474),
toujours ouverte). Un mainteneur y indique que l'API JSON est la voie vivante et que
le site tarkov.dev s'appuie dessus. Même projet, même organisation, toujours gratuite
et sans clé.

`https://json.tarkov.dev/{gameMode}/items` — 5 312 objets, 16,7 Mo (1,4 Mo compressé,
~0,5 s). Le mode de jeu est un segment de chemin : `regular`, `pve`.

#### Particularités à absorber

Cette API n'a pas la même forme que GraphQL, et une différence est piégeuse :

| | GraphQL | JSON |
|---|---|---|
| `data.items` | tableau | objet indexé par id |
| `name`, `shortName` | valeurs réelles | **placeholders** : littéralement `"<id> Name"` |
| prix traders | `sellFor` (noms inclus) | `sellToTrader` (ids) + jointure sur `/traders` |
| mode de jeu | argument `gameMode` | segment de chemin |

Les noms **ne sont pas dans cette réponse**. Le champ `translations` ne contient que
des JSONPath décrivant *quels* champs sont traduisibles ; aucun paramètre de langue
testé (`?language`, `?lang`, `?locale`, en-tête `Accept-Language`) ne les renseigne.

Deux champs sauvent la situation, tous deux en anglais réel :

- `wikiLink` (96,8 % des objets) porte le nom exact, souligné —
  `.../wiki/Colt_M4A1_5.56x45_assault_rifle` → « Colt M4A1 5.56x45 assault rifle » ;
- `normalizedName` (100 %) est le slug — `colt-m4a1-556x45-assault-rifle`.

Le nom affiché vient du wiki quand il existe, du slug sinon. **Les deux formes sont
indexées** pour la correspondance : le slug perd les points (`556x45`), mais le moteur
compare des bigrammes sans espaces, où `5 56x45` et `556x45` se rejoignent.

`shortName` est irrécupérable — seule perte face à GraphQL. Le badge de nom court
disparaît de la carte ; sans conséquence sur la détection, qui lit le nom complet.

#### Protections

- **Repli de source.** En mode `auto`, un échec JSON bascule sur GraphQL. L'ordre
  inverse ferait attendre trois échecs GraphQL (~3 s) à chaque rafraîchissement.
- **Repli de schéma GraphQL.** Si le serveur rejette l'argument `gameMode`, le client
  rejoue la requête sans lui et signale que les prix sont ceux du mode `regular`.
- **Retry avec backoff** (1 s, 2 s) sur erreur réseau, 5xx et 429. Le cas
  `422 Unprocessable Entity` accompagné d'un corps « server unavailable » — la réponse
  réelle de la passerelle GraphQL quand l'origine est en panne — est traité comme
  transitoire, pas comme une erreur client.
- **Mode dégradé.** Tout échec laisse le cache disque en place. L'outil reste
  pleinement utilisable hors ligne, avec un bandeau signalant la péremption.
- **Rattrapage quand le cache est vide.** Le cycle normal (12 min) convient à des
  prix qui vieillissent, pas à une application inutilisable. Tant qu'aucune donnée
  n'est disponible, l'outil retente à 30 s, 60 s, 2 min, 4 min, puis toutes les
  5 minutes. Si l'API revient pendant que vous jouez, les prix se chargent seuls,
  sans rien relancer.

---

## Performances

L'objectif est de ne pas coûter de FPS. Trois décisions y contribuent :

**1. Le travail permanent est trivial.** Seule la lecture de la position du curseur
tourne en continu, à 60 ms d'intervalle. La chaîne coûteuse ne démarre que si *toutes*
ces conditions sont réunies :

- l'overlay est actif ;
- le cache de prix est rempli ;
- Tarkov est au premier plan ;
- le curseur est immobile depuis `hoverSettleMs` ;
- `minOcrIntervalMs` s'est écoulé depuis le dernier OCR ;
- cette position n'a pas déjà été analysée trois fois sans succès.

En déplacement continu de souris, **aucun OCR n'est lancé**. Le triple essai par
position existe parce que l'infobulle de Tarkov apparaît avec un léger délai : le
premier essai tombe souvent sur une zone encore vide.

**2. L'overlay est une petite fenêtre affichée ponctuellement**, pas une surface
transparente plein écran permanente. Une fenêtre transparente couvrant l'écran doit
être recomposée par le DWM à chaque image du jeu — exactement ce qu'on cherche à
éviter. La carte est repositionnée et affichée à la demande, et cachée sinon. Aucune
animation, aucune transition, aucun `backdrop-filter`.

**3. La capture passe par un flux vidéo persistant, pas par `desktopCapturer`.**

C'est la décision qui pèse le plus lourd. Mesures sur Windows 11, écran 2560×1440
@ scaleFactor 1,5 :

| Appel | Coût |
|---|---|
| `desktopCapturer.getSources`, vignette **1×1** | **168 ms** |
| `desktopCapturer.getSources`, vignette 2560 | 194 ms |
| `desktopCapturer.getSources`, vignette native (3840) | 242 ms |
| `capturePage` sur un flux `getUserMedia` persistant | **52 ms** |

Une vignette 1×1 ne capture aucun pixel et coûte pourtant 168 ms : l'essentiel du
temps part dans l'**énumération des sources**, refaite à chaque appel. Cette API
convient à un sélecteur de source, pas à une capture répétée.

`FrameGrabber` ouvre donc **une seule fois** un flux `getUserMedia` de type `desktop`
dans une fenêtre cachée, et y lit une image à la demande. La fenêtre est dimensionnée
pour capturer à la résolution *logique* : en 1440p @ 1,5, capturer les 3840 px
physiques ne fait que gonfler mémoire et CPU, alors que le texte d'une infobulle fait
déjà ~17 px logiques, soit ~34 px après l'agrandissement ×2 — la plage où Tesseract
est le plus fiable.

Si le flux échoue (pilote, permission), `ScreenCapture` retombe automatiquement sur
`desktopCapturer` : plus lent, mais fonctionnel.

**4. Coûts mesurés de bout en bout** (même machine) :

| Étape | Avant | Après |
|---|---|---|
| Capture | 228 ms | **40 ms** |
| Localisation de l'infobulle (6 seuils) | 23 ms | 28 ms |
| Prétraitement (JS pur) | <1 ms | <1 ms |
| OCR Tesseract | 50–90 ms | 50–90 ms |
| Correspondance floue (5 300 objets) | 2–5 ms | 2–5 ms |
| **Pipeline** | **251 ms** | **68 ms** |
| + immobilité requise avant déclenchement | 180 ms | 120 ms |
| **Latence ressentie** | **~510 ms** | **~270 ms** |

Empreinte : ~620 Mo au total (processus principal ~250 Mo, GPU ~175 Mo, overlay
~60 Mo, flux ~95 Mo), plus ~40 Mo pour le surveillant PowerShell. La fenêtre de
configuration n'est créée qu'à la première ouverture. Charge CPU avec le flux actif :
**~1,2 à 1,7 % du système** (16 cœurs logiques). Le flux est libéré dès que la
détection s'arrête.

---

## Tests

```bash
npm test              # les deux suites
npm run test:match    # correspondance floue (Node pur, instantané)
npm run test:ocr      # chaîne OCR complète (nécessite Electron)
npm run typecheck     # tsc --noEmit
npm run verify-api    # diagnostic de l'API tarkov.dev
```

**`test:ocr`** se déroule en deux phases, toutes deux dans une fenêtre hors écran, et
fait traverser aux images *exactement* le même code que la détection réelle. Les
images prétraitées sont écrites dans `dist/selftest/`.

*Phase 1 — lecture.* Treize fausses infobulles (même palette, même taille de police
que Tarkov) sont rendues, capturées, puis passées à `preprocessForOcr` → `OcrEngine`
→ `ItemIndex`.

*Phase 2 — cadrage.* Une scène d'inventaire synthétique est reconstruite — grille
olive, icônes sombres en silhouette, étiquettes de quantité, barre latérale — avec
une infobulle à une position connue. Le test vérifie que `locateTooltip` retrouve son
rectangle (IoU ≥ 0,7) **et** que le nom y est lisible, sur quatre placements
(au-dessus/en dessous, à gauche/à droite) plus un cas négatif sans infobulle, qui ne
doit rien détecter.

> Les deux phases ont trouvé un vrai défaut chacune.
>
> **Phase 1 :** la première implémentation du prétraitement utilisait un étirement de
> contraste sur percentiles et donnait **0/13**, le texte disparaissant entièrement de
> l'image. Le texte occupant moins de 5 % des pixels d'une infobulle, même un 95ᵉ
> percentile tombe encore dans le fond. Le seuillage d'Otsu, qui cherche la frontière
> entre les deux populations quelle que soit leur proportion, donne **13/13**.
>
> **Phase 2 :** la première version du localisateur donnait **0/4** sur les cas
> positifs. L'infobulle se superposant à l'inventaire, ses bords touchent les icônes
> sombres du fond ; les composantes connexes fusionnaient, le rectangle englobant
> débordait et le taux de remplissage s'effondrait. D'où le rognage des bords décrit
> plus haut — **4/4** ensuite, avec un IoU de 0,91 à 0,97.

> Ce test a servi : la première implémentation du prétraitement utilisait un
> étirement de contraste sur percentiles et donnait **0/12**, le texte disparaissant
> entièrement de l'image. Le texte occupant moins de 5 % des pixels d'une infobulle,
> même un 95ᵉ percentile tombe encore dans le fond. Le seuillage d'Otsu, qui cherche
> la frontière entre les deux populations quelle que soit leur proportion, donne
> **12/12** avec un texte OCR exact.

**`test:match`** attaque le moteur de correspondance avec 33 cas de bruit OCR
réaliste : substitutions `l`/`I`/`1`, `O`/`0`, `rn`→`m`, lettres manquantes ou
dupliquées, texte d'interface capturé en marge, noms très proches
(`AK-74N` / `AKS-74N`, `BP` / `BS`, `Car` / `Tank battery`).

Un tiers des cas sont **négatifs** — `STASH`, `FILTER BY`, `TACTICAL RIG`,
`BODY ARMOR`, `QUICK USE`, un montant seul, un nom de trader — et doivent rester sous
le seuil. Ils comptent autant que les positifs : un faux positif affiche un prix faux,
ce qui est pire que ne rien afficher.

> Ces cas négatifs viennent d'un faux positif observé en jeu : une correspondance à
> 63 % affichait « Aluminum splint » sur du texte d'interface quelconque. Deux
> corrections : seuil relevé de 0,62 à **0,68** (les lectures légitimes, même très
> bruitées, scorent 0,71 et plus), et **garde-fou d'ambiguïté** — un score faible
> *et* disputé par un autre item est rejeté. Un score élevé reste accepté même si un
> voisin suit de près, sinon `AK-74N` et `AKS-74N` s'annuleraient mutuellement.

---

## Dépannage

**« Aucun prix » au démarrage**

Lancez `npm run verify-api`. Le script vérifie les deux sources : catalogue
d'endpoints, table des traders, puis pour chaque mode de jeu le nombre d'objets, la
présence de chaque champ consommé et la couverture des noms.

Une sortie saine ressemble à ceci :

```
1. Catalogue des endpoints
  [OK]    9 endpoints, modes : regular, pve, pvp-season
3. Items — mode regular
  [OK]    5312 items en 310 ms
  [OK]    noms : 5141 via wikiLink, 171 deduits du slug (couverture 100.0 %)
```

**La ligne GraphQL en `->  indisponible — HTTP 422` est normale** et n'empêche rien :
c'est la panne connue depuis juillet 2026, et l'application utilise l'API JSON.

Si l'API JSON elle-même échoue, distinguez panne de service et problème local :

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://json.tarkov.dev/endpoints
```

Un 200 ici avec un échec dans l'application pointe vers un bug de l'outil ; un code
d'erreur ou un timeout pointe vers le service ou votre réseau. Dans tous les cas,
laissez l'application ouverte : elle retente automatiquement (voir *Rattrapage*).

**L'overlay n'apparaît jamais en jeu**

1. Tarkov est-il en **plein écran fenêtré** ? Le plein écran exclusif ne peut pas être
   survolé (voir [Limites](#limites-connues)).
2. Onglet Debug → *Analyser maintenant* pendant qu'une infobulle est visible. Le champ
   *Abandon* indique la cause exacte : `jeu non au premier plan`,
   `aucune infobulle détectée autour du curseur`, `meilleur score X sous le seuil`…
3. Comparez les deux images du panneau (fenêtre de recherche / zone retenue) comme
   décrit dans [Vérifier ce que voit le détecteur](#vérifier-ce-que-voit-le-détecteur).
4. Si le texte est correct mais le score trop bas, baissez `matchThreshold` à 0,55.

**`Cannot read properties of undefined (reading 'app')` au lancement**

Le terminal intégré de VS Code exporte `ELECTRON_RUN_AS_NODE=1`, ce qui fait démarrer
Electron comme un simple Node. `npm start` passe par `scripts/start.mjs`, qui
supprime cette variable — utilisez `npm start` plutôt que `npx electron .`.

**Un raccourci ne répond pas**

Une autre application l'a déjà capté (Discord, Steam, GeForce Experience). Le refus est
silencieux côté Windows ; il est journalisé côté outil : *Général → Ouvrir les logs*,
cherchez `raccourci ... refuse`. Changez-le dans l'onglet Raccourcis.

**Objet reconnu, mais ce n'est pas le bon**

Score sous 80 % (indicateur orange) : la zone de capture attrape probablement du texte
voisin. Réduisez `width` / `height`, ou montez `matchThreshold`.

**Consommation CPU trop élevée**

Montez `minOcrIntervalMs` (à 600) et `hoverSettleMs` (à 300). Vérifiez que
`onlyWhenGameFocused` est actif.

---

## Limites connues

- **Plein écran exclusif : impossible.** Aucun overlay externe ne peut s'afficher
  par-dessus, quel que soit le logiciel — c'est une propriété du mode d'affichage, pas
  une limite de cet outil. Utilisez le **plein écran fenêtré** (borderless), ce que
  recommandent de toute façon tous les overlays.
- **L'OCR dépend de l'infobulle du jeu.** Pas d'infobulle → rien à lire. Les objets
  survolés trop brièvement ne sont pas détectés.
- **La détection automatique suppose une infobulle nettement plus sombre que le fond.**
  C'est le cas de l'interface de Tarkov, mais un réglage de gamma très élevé pourrait
  réduire l'écart. Le mode zone fixe reste le recours.
- **Anglais uniquement.** Les noms tarkov.dev sont en anglais ; Tarkov doit être en
  anglais pour que les noms correspondent. Faire fonctionner une autre langue
  demanderait le pack Tesseract correspondant *et* une table de correspondance des
  noms — l'API ne fournit pas les traductions dans la requête utilisée ici.
- **Objets dont le nom est ambigu.** Certains noms courts sont partagés par plusieurs
  variantes ; le moteur privilégie le nom le plus long donc le plus spécifique, mais
  l'ambiguïté reste possible. L'indicateur de confiance sert à ça.
- **Le surveillant de fenêtre active coûte ~40 Mo** (un processus PowerShell). Il est
  désactivable via `onlyWhenGameFocused: false`, au prix d'analyses inutiles hors jeu.
- **Windows uniquement.** `ForegroundWatcher` se désactive proprement ailleurs, mais
  le reste n'a jamais été testé hors Windows.

---

## Posture vis-à-vis de BSG

Ce que l'outil fait, et à quoi c'est équivalent :

| Action | Équivalent grand public |
|---|---|
| Capture d'écran de la zone du curseur | n'importe quel outil de capture, OBS, Xbox Game Bar |
| Lecture de la position du curseur | toute application Windows |
| Lecture du nom du processus de la fenêtre active | Gestionnaire des tâches |
| Affichage d'une fenêtre always-on-top | Discord, Steam, GeForce Experience |
| Requêtes HTTP vers une API publique | un navigateur |

Ce que l'outil ne fait **à aucun moment** : lecture ou écriture de la mémoire du jeu,
injection de DLL, hook d'API, modification de fichiers du jeu, interception ou
altération du trafic réseau du jeu, automatisation d'entrées clavier/souris, lecture
de données non affichées à l'écran.

Autrement dit, il ne donne accès à **aucune information que le joueur n'a pas déjà
sous les yeux** : il évite un alt-tab vers le wiki, rien de plus.

Cela dit — et c'est important — **BSG ne publie aucune liste blanche d'outils tiers**,
et leurs conditions d'utilisation restent volontairement larges sur les logiciels
externes. Ce document décrit une intention de conception, pas une garantie. Personne
ne peut vous en donner une.

---

## Modifier le projet

```bash
npm run watch      # esbuild en mode watch
npm run dev        # lancement avec logs verbeux
```

Après une modification du code du processus principal, relancez l'application
(`watch` reconstruit le bundle mais ne redémarre pas Electron). Les modifications des
renderers nécessitent seulement un rechargement de la fenêtre.

**Ajouter un réglage :** une entrée dans `AppConfig` et `DEFAULT_CONFIG`
(`src/types/index.ts`), éventuellement une borne dans `sanitize()`
(`ConfigStore.ts`), et une ligne de HTML avec `data-config="maCle"` dans
`src/ui/index.html`. La liaison est automatique.

**Ajouter un champ de prix :** ajoutez-le à la requête et à `normalizeItems()`
(`TarkovApi.ts`), à `TarkovItem` et `PriceSummary` (`types/index.ts`), à
`buildSummary()` (`ItemIndex.ts`), puis affichez-le dans `src/overlay/`. Pensez à
incrémenter `CACHE_VERSION` dans `PriceCache.ts` pour invalider les caches existants.

**Régler la correspondance :** toute la logique est dans `ItemIndex.search()`, et
`npm run test:match` boucle en moins d'une seconde. Ajoutez vos cas d'échec réels dans
`src/tools/match-selftest.ts` avant de toucher au scoring.

---

## Crédits

Prix et données d'objets : [tarkov.dev](https://tarkov.dev) — API publique, gratuite,
communautaire. Si l'outil vous est utile, [soutenez-les](https://tarkov.dev/about).

OCR : [tesseract.js](https://github.com/naptha/tesseract.js).

Projet non affilié à Battlestate Games.
