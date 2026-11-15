# Legrand In One CPL

Intégration non officielle, sans lien avec Legrand. Elle permet de piloter depuis Gladys les éclairages, variateurs et volets d'une installation Legrand In One (courants porteurs, « CPL ») et d'afficher leur état quand quelqu'un appuie sur un interrupteur mural.

## Ce qu'il vous faut

- Une interface Legrand USB / RS232, référence 882 13, branchée sur la machine qui fait tourner Gladys.
- Un petit conteneur « passerelle série » qui expose ce périphérique USB sur un port TCP. Les intégrations Gladys ne peuvent pas accéder directement aux périphériques USB : ce conteneur le fait à leur place (voir le README du projet pour un `docker-compose.yml` prêt à l'emploi).

## Installation

1. Démarrez le conteneur de la passerelle série. Par défaut, il écoute sur `172.17.0.1:2000`.
2. Installez cette intégration et vérifiez l'adresse et le port dans ses paramètres.
3. **Appuyez une fois sur chaque interrupteur.** Le bus Legrand ne sait pas lister ses équipements : l'intégration apprend chaque circuit à partir des trames que les interrupteurs envoient quand on appuie dessus.
4. Ouvrez l'onglet Découverte et lancez une recherche. Chaque circuit vu sur le bus apparaît comme une lumière nommée `Legrand <id>-<unité>` (ou un volet `Legrand volet <id>-<unité>`), suivie entre parenthèses du type d'appareil : `(inter)` pour un interrupteur, `(variateur)` pour une touche de variateur, `(inter volet)` pour un inter de volet, `(inter scenario)` pour la touche marche/arrêt d'un interscénario. Ce type est déduit des touches déjà entendues : un interscénario dont seule la touche marche/arrêt a été pressée apparaît d'abord comme `(inter)`, puis passe à `(inter scenario)` dès qu'une de ses touches de scène parle. Créez les circuits que vous voulez et renommez-les.

Si un interrupteur n'apparaît pas, appuyez dessus de nouveau et relancez la recherche. La liste des circuits connus est conservée après un redémarrage.

## Ce que fait l'intégration

- Allume et éteint les lumières depuis Gladys (tableau de bord, scènes, voix).
- Règle le niveau des variateurs (luminosité de 20 à 100 %, voir « Variateurs »).
- Monte, descend et arrête les volets (voir « Volets »).
- Met à jour l'état dans Gladys quand un interrupteur mural est utilisé.
- Affiche chaque bouton de scénario Legrand comme un bouton dans Gladys (`Legrand scenario <id>-<unité>`). Il « clique » quand le scénario est lancé sur une touche murale : vous pouvez l'utiliser comme déclencheur dans les scènes Gladys. Inversement, une scène Gladys peut **cliquer** sur ce bouton pour lancer le scénario Legrand (voir « Lancer un scénario Legrand depuis Gladys »).

## Appareils liés

Le bus ne dit jamais l'état d'un récepteur. Quand un bouton pilote plusieurs lumières (un groupe, une scène), seul le bouton envoie une trame et les lumières restent muettes. Les réglages **Règle 1** à **Règle 12** (une règle par champ) indiquent à l'intégration quelles lumières suivent quel bouton. Rien n'est envoyé sur le bus : seul l'état affiché dans Gladys est mis à jour.

Utilisez les numéros de circuit affichés dans les journaux (`944559-1`). Une règle par champ. S'il vous faut plus de 12 règles, mettez-en plusieurs dans un même champ, séparées par `;` :

```
648966-1 -> 944559-1, 944559-2
648966-2 -> 944559-1=on, 944559-2=off
```

Plusieurs règles dans un seul champ : `929520-1 -> 944561-1; 929523-1 -> 944561-1`.

- Avec une lumière à gauche, les lumières de droite copient son état (allumée, éteinte), qu'il vienne d'un interrupteur mural ou d'une commande dans Gladys.
- Avec un bouton de scène à gauche, chaque lumière de droite prend l'état fixe écrit après `=` (`on` ou `off`).

## Variateurs

Un variateur In One (672 10, 672 12, 672 14, prisinter 672 22, télévariateur 036 10…) parle le même langage qu'un inter, avec en plus des ordres de **niveau** (de 20 à 100 % par pas de 10) et de variation (plus / moins). Dès que l'intégration entend une trame de niveau sur un circuit, elle le considère comme un variateur : relancez une découverte et l'appareil Gladys reçoit, en plus de marche/arrêt, une **luminosité** de 0 à 100 %.

- Si votre variateur n'envoie jamais de trame de niveau (touche à appui bref seulement), indiquez son circuit dans le réglage **Variateurs** (`944559-1, 944560-2`) : la luminosité est ajoutée à la découverte suivante.
- Depuis Gladys, une luminosité de 0 éteint ; toute autre valeur est arrondie au pas le plus proche (1 à 24 → 20 %, 55 → 60 %). La valeur réellement envoyée est réaffichée dans Gladys.
- Une touche murale « plus » ou « moins » ne dit pas le niveau atteint : Gladys garde le dernier niveau connu.

**Cette partie suit la spécification Open Web Net mais n'a pas encore été vérifiée sur un variateur réel.** Si vous en avez un, un retour (trames vues dans les journaux, résultat des commandes) sur le dépôt GitHub permettra de la valider.

## Volets

Un inter de volet In One (672 51, 672 55, 672 56, commandes 672 53 / 672 54) émet des ordres **montée**, **descente** et **arrêt**. Chaque touche entendue apparaît à la découverte comme un volet `Legrand volet <id>-<unité>` avec une commande à trois positions dans Gladys : monter, arrêter, descendre.

- L'état affiché est le **dernier ordre** entendu ou envoyé, pas la position réelle : le bus ne la connaît pas.
- Sur un inter de volet, un appui bref lance la montée ou la descente complète et un appui prolongé sert au réglage ; depuis Gladys, l'intégration envoie l'ordre tel quel. Un volet en mouvement s'arrête avec « arrêter ».
- Les volets ne participent pas aux règles « Appareils liés » (réservées aux lumières).

**Cette partie suit la spécification Open Web Net mais n'a pas encore été vérifiée sur un volet réel.** Même demande : si vous testez, dites-le sur le dépôt GitHub.

## Matériel testé

Cette intégration a été mise au point sur une seule installation, avec :

- l'interface Legrand CPL/USB **réf. 882 13** (vue par Linux comme un périphérique série USB BTicino « SFERA Tele Loop ») ;
- des interrupteurs doubles émetteurs-récepteurs **réf. 672 02** (deux directions : touche du haut = allumer, touche du bas = éteindre) ;
- un interrupteur simple émetteur-récepteur **réf. 672 01** (trames reçues et décodées ; commande depuis Gladys non testée) ;
- un interscénario d'éclairage **réf. 672 08** (touches marche/arrêt + deux touches de scénario) ;
- un interscénario émetteur **réf. 672 80** (quatre touches de scénario) ;
- Gladys Assistant 5.3 sur un Home Assistant Yellow (ARM 64 bits).

## Comment lire les appareils dans Gladys

Dans le système In One, chaque produit a un identifiant unique et chaque récepteur *apprend* les émetteurs qui le commandent (touche LEARN). Sur le bus ne circulent que des ordres d'**émetteurs** : « la direction 1 de l'émetteur 944559 dit *allumer* ». Les récepteurs qui ont appris cet émetteur réagissent, sans rien dire.

Un appareil `Legrand 944559-1` dans Gladys est donc **une touche d'émetteur** (identifiant 944559, direction 1), pas une lampe. Le commander depuis Gladys revient à appuyer sur cette touche : tous les récepteurs qui l'ont apprise réagissent. C'est pourquoi un émetteur appris par plusieurs récepteurs allume plusieurs lampes, et pourquoi l'état d'un récepteur ne peut jamais être lu : il n'existe pas sur le bus. Le réglage **Appareils liés** sert à décrire ces associations pour que Gladys affiche le bon état.

## Références de la gamme In One CPL

D'après le guide technique Céliane. Seules les quatre références ci-dessus ont été testées ; pour les autres, la colonne « Attendu » dit ce que le protocole laisse prévoir, **sans vérification**. Depuis la version 0.6.0, toute la gamme CPL d'éclairage, de variation et de volets est prise en charge par le code : il ne manque que des testeurs.

**Éclairage**

| Référence | Produit | Attendu |
|---|---|---|
| 672 01 | Inter simple émetteur-récepteur 2 500 W | **Testé** en réception ; commande attendue comme le 672 02 |
| 672 02 | Inter double émetteur-récepteur 2 × 1 000 W | **Testé** |
| 672 03 / 672 04 | Inter simple / double à voyant | Comme 672 01 / 672 02 : devrait fonctionner (le voyant est local, il ne remonte pas sur le bus) |
| 672 08 | Interscénario d'éclairage (marche/arrêt + 2 scénarios) | **Testé** |
| 672 15 | Inter automatique 1 000 W (détecteur) | Devrait émettre des ordres marche/arrêt comme un inter |
| 672 10 / 672 12 / 672 14, 036 10 | Variateurs 300 W, 600 W et télévariateur 1 000 W | Marche/arrêt + luminosité 20–100 % (voir « Variateurs ») ; à vérifier |
| 672 22 | Prisinter variateur-récepteur | Comme un variateur ; à vérifier |
| 882 03 | Prisinter variateur mobile 500 W | Comme un variateur ; à vérifier |
| 882 00, 882 01, 882 15, 882 20 | Télécommandes et interscénarios infrarouge/radio | Non : ils ne passent pas par le bus CPL, sauf via un récepteur CPL/IR qui relaie |

**Scénarios**

| Référence | Produit | Attendu |
|---|---|---|
| 672 80 | Interscénario émetteur (4 scénarios) | **Testé** |
| 672 84 | Gestionnaire de scénarios à écran tactile | Ses scénarios devraient apparaître comme des boutons ; non vérifié |

**Volets et stores**

| Référence | Produit | Attendu |
|---|---|---|
| 672 51 / 672 55 / 672 56 | Inter individuel de volet (simple, avec dérogation, à niveau programmable) | Montée / descente / arrêt (voir « Volets ») ; à vérifier |
| 672 53 / 672 54 | Commande centralisée / commande de groupe (4 zones) | Chaque touche devrait apparaître comme un volet ; à vérifier |
| 672 62 | Inter centralisé de volets radio | Non : radio, sauf via l'interface CPL/RF 036 06 qui relaie |

**Chauffage, détecteurs, interfaces** : thermostats 674 40 / 674 42, sortie de câble 674 45, dérogation 674 48, programmateur 674 49, détecteurs 675 22 / 675 23 / 675 24, interfaces 036 06 / 036 07 / 036 18 — hors du périmètre de cette intégration. Les filtres 882 12 / 882 21 / 882 23 sont des accessoires passifs.

Si vous testez l'une de ces références, dites-le sur le dépôt GitHub du projet : le tableau sera mis à jour.

## Envoi des commandes

L'interface 882 13 émet une commande à la fois sur le courant porteur et refuse celle qui arrive pendant qu'elle émet encore la précédente. L'intégration envoie donc les commandes une par une : elle attend la réponse de l'interface (acceptée ou refusée) puis une courte pause avant la suivante, et renvoie jusqu'à trois fois une commande refusée. Une commande toujours refusée est signalée en échec dans Gladys, et l'état affiché ne change pas. Une scène qui commande dix lampes prend ainsi quelques secondes.

## Lancer un scénario Legrand depuis Gladys

Dans une scène Gladys, ajoutez l'action « Contrôler un appareil », choisissez `Legrand scenario <id>-<unité>` et cliquez sur le bouton. L'intégration envoie **une seule trame** sur le courant porteur (`*25*11*#<adresse>##`) : les récepteurs qui ont appris ce scénario font le reste. Cela coûte une trame, quel que soit le nombre de lampes : c'est la bonne façon d'éteindre ou d'allumer beaucoup de lampes d'un coup.

- Un scénario qui n'a été programmé sur aucun récepteur ne fait rien.
- Appuyer sur la touche murale ne fait qu'écouter : l'intégration n'envoie jamais rien en réponse à une trame reçue.
- Un scénario lancé depuis Gladys ne déclenche pas de « clic » en retour dans Gladys (pas de boucle avec une scène déclenchée par ce même bouton). Les appareils liés sont mis à jour dans Gladys comme pour un appui mural.
- Les appareils scénario créés avec une version antérieure à la 0.5.0 sont en lecture seule : supprimez-les dans Gladys et refaites une découverte pour qu'ils puissent être cliqués.

## Limites de cette version

- Le bus ne signale jamais l'état réel d'un récepteur. L'état affiché dans Gladys est déduit des trames et des commandes envoyées : il peut se décaler (par exemple après un scénario Legrand qui éteint des lampes). Une commande depuis Gladys le remet toujours d'accord.
- Pour tenir Gladys à jour après un scénario Legrand, utilisez les appareils liés (règle `scénario -> lampe=on`).
- Variateurs et volets : écrits d'après la spécification Open Web Net, non encore vérifiés sur matériel. Le niveau d'un variateur n'est connu qu'après une trame de niveau ; la position d'un volet n'est jamais connue (seul le dernier ordre l'est).
- Les scénarios se lancent mais ne se programment pas depuis Gladys : ils doivent avoir été appris par les récepteurs (procédure Legrand).
