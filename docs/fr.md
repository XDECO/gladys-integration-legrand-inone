# Legrand In One CPL

Intégration non officielle, sans lien avec Legrand. Elle permet d'allumer et d'éteindre depuis Gladys les éclairages d'une installation Legrand In One (courants porteurs, « CPL ») et d'afficher leur état quand quelqu'un appuie sur un interrupteur mural.

## Ce qu'il vous faut

- Une interface Legrand USB / RS232, référence 882 13, branchée sur la machine qui fait tourner Gladys.
- Un petit conteneur « passerelle série » qui expose ce périphérique USB sur un port TCP. Les intégrations Gladys ne peuvent pas accéder directement aux périphériques USB : ce conteneur le fait à leur place (voir le README du projet pour un `docker-compose.yml` prêt à l'emploi).

## Installation

1. Démarrez le conteneur de la passerelle série. Par défaut, il écoute sur `172.17.0.1:2000`.
2. Installez cette intégration et vérifiez l'adresse et le port dans ses paramètres.
3. **Appuyez une fois sur chaque interrupteur.** Le bus Legrand ne sait pas lister ses équipements : l'intégration apprend chaque circuit à partir des trames que les interrupteurs envoient quand on appuie dessus.
4. Ouvrez l'onglet Découverte et lancez une recherche. Chaque circuit vu sur le bus apparaît comme une lumière nommée `Legrand <id>-<unité>`. Créez ceux que vous voulez et renommez-les.

Si un interrupteur n'apparaît pas, appuyez dessus de nouveau et relancez la recherche. La liste des circuits connus est conservée après un redémarrage.

## Ce que fait l'intégration

- Allume et éteint les lumières depuis Gladys (tableau de bord, scènes, voix).
- Met à jour l'état dans Gladys quand un interrupteur mural est utilisé.
- Affiche chaque bouton de scénario Legrand comme un bouton dans Gladys (`Legrand scenario <id>-<unité>`). Il « clique » quand le scénario est lancé : vous pouvez l'utiliser comme déclencheur dans les scènes Gladys.

## Boutons poussoirs à bascule

Certains boutons muraux envoient la même trame « allumer » à chaque appui, alors que le récepteur s'allume et s'éteint en alternance. Le bus ne dit pas l'état réel : listez ces circuits dans le réglage **Boutons poussoirs à bascule**, avec les numéros vus dans les journaux (par exemple `10383457, 15112946`). Chaque appui inverse alors l'état affiché dans Gladys.

## Limites de cette version

- Le bus ne signale jamais l'état réel d'un récepteur. L'état affiché dans Gladys est déduit des trames et des commandes envoyées : il peut se décaler (par exemple après un scénario Legrand qui éteint des lampes). Une commande depuis Gladys le remet toujours d'accord.
- Pour tenir Gladys à jour après un scénario Legrand, créez une scène Gladys déclenchée par le bouton du scénario, qui met les lampes concernées dans leur nouvel état.
- Lumières tout ou rien uniquement : pas de variateurs, pas de volets, et Gladys ne peut pas lancer un scénario Legrand.
