# Parkeren Jutfasehof

Web-app waarmee bewoners van Peizerdiep (15 t/m 27 oneven, 32 t/m 38 even) hun parkeerplek (P08 t/m P19) vrijgeven als ze weg zijn, zodat buren hem kunnen claimen.

- Hosting: GitHub Pages (gratis)
- Gegevens en inloggen: Firebase, Spark-abonnement (gratis)
- Toegang: account met e-mail en wachtwoord, plus de buurtcode

## Bestanden

| Bestand | Wat |
|---|---|
| `index.html` | Opmaak en schermen |
| `app.js` | Alle logica |
| `config.js` | Gegevens van het Firebase-project (niet geheim) |
| `firestore.rules` | Beveiligingsregels, plakken in Firebase onder Firestore > Regels |
| `manifest.webmanifest`, `icon-*.png` | Voor "Zet op beginscherm" |

## Beheer

**Buurtcode instellen of wijzigen**
Firebase-console > Firestore Database > Gegevens > collectie `private` > document `join` > veld `code` (tekst).
Bestaande leden houden toegang als je de code wijzigt.

**Iemand de toegang afnemen**
Firestore > collectie `members` > zoek het document met het juiste e-mailadres > verwijderen.
Verwijder ook het account onder Authentication > Gebruikers.

**Een plek loskoppelen die op het verkeerde nummer staat**
Firestore > collectie `spots` > document van de plek (bijv. `P08`) > veld `house` aanpassen of leegmaken.

## Gegevens in Firestore

| Collectie | Inhoud |
|---|---|
| `members/{uid}` | huisnummer, buurtcode, e-mail van een lid |
| `spots/{P08..P19}` | gekoppeld huisnummer, `charger` (openbare laadpaal ja/nee) |
| `houses/{nr}` | optioneel WhatsApp-nummer |
| `releases` | eenmalige vrijgaven (`from`, `until` in ms) |
| `recurring` | wekelijkse vrijgaven (dagen, tijden, uitzonderingen per keer) |
| `claims/{plek}` | alle claims van die plek in één document (`items`), gewijzigd via transacties |
| `requests` | verzoeken om een plek |
