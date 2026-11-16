# Obelix Strom Dashboard – Entwicklerdokumentation

Stand: November 2026 (neues Aussehen „hell & klar“, deutsche Ladezustände, Tests im Repo).

## 1. Zweck

Statische Webseite als Strom-Monitor fürs Wohnmobil „Obelix“. Sie liest per Web Bluetooth die Messwerte aller Strom-Geräte und zeigt sie als Kacheln an, zwei nebeneinander, alle Geräte ohne Scrollen auf einer iPad-Seite.

- Zielgerät: altes iPad Air 2 (iPadOS 15.8.8) im Browser **Bluefy** (Safari kennt kein Web Bluetooth). Läuft auch in **Chrome auf Android**.
- Kein Build, keine Abhängigkeiten, kein Server. Hosting über GitHub Pages: https://hagi089.github.io/victron-monitor/
- Code im **ES5-Stil** (`var`, `function`, Promises) wegen des alten iPads. Keine CSS-Funktionen, die Safari 15 nicht kann (z. B. kein `color-mix`).

## 2. Geräte

| Kachelname | Gerät | Anbindung |
|---|---|---|
| Obelix AGM 200ah | Victron SmartShunt an AGM-Batterie 200 Ah (nur 50 % nutzbar) | Instant Readout, Typ 0x02 |
| Obelix Solar 100/20 | Victron SmartSolar 100/20 | Instant Readout, Typ 0x01 |
| Obelix Solar 75/15 | Victron SmartSolar 75/15 | Instant Readout, Typ 0x01 |
| Obelix 12/25 HQ260 | Victron Blue Smart IP65 Ladegerät | Instant Readout, Typ 0x08 |
| Obelix Lithium 200ah | LANGZEIT LiFePO4 200 Ah, BLE-Name `DP04S007L4S100A` (JBD-BMS) | GATT, nur lesen |
| Obelix 230 Volt (außen) | Voltcraft SEM6000 Zwischenstecker, BLE-Name „Voltcraft“ | GATT mit PIN, nur lesen |

Die Kachelnamen sind eigene Anzeigenamen (`victron-names`), die BLE-Namen bleiben unverändert, weil sie zum Verbinden gebraucht werden.

## 3. Dateien und Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Kopfzeile (Symbol, Titel, Uhr, Knöpfe), Kachelbereich, Status, Diagnose. CSP-Meta-Tag. |
| `theme.js` | Setzt `data-theme` aus `victron-theme`, bevor die Seite gezeichnet wird. |
| `style.css` | Komplettes Aussehen, hell und dunkel über CSS-Variablen. |
| `app.js` | Oben der **PURE-Block** (`/* PURE-BEGIN */` … `/* PURE-END */`): reine, testbare Funktionen ohne DOM. Danach eine IIFE mit UI und Bluetooth. |
| `tests/unit.js` | Unit-Tests des PURE-Blocks (Node). |
| `tests/pentest.js` | 17 Sicherheitsprüfungen in Chromium mit echter CSP (Playwright). |
| `tests/mock-bt.js` | Simuliertes `navigator.bluetooth` mit allen 6 Geräten (Testschlüssel). |
| `tests/screenshots.py` | Screenshots quer/hochkant/Handy, hell/dunkel, mit Warnwerten. |
| `landscape.png`, `portrait.png` | Ansichten mit simulierten Daten (für README). |

### PURE-Block (app.js)

- `decodeSolar`/`decodeSolarView`, `decodeBattery`, `decodeCharger`, `decodeAny` – Victron-Datensätze
- `counterBlock`, `decryptPayload` – AES-128-CTR über WebCrypto
- `JbdAssembler`, `decodeJbdBasic`, `decodeJbdCells`, `cellCheck`, `jbdView` – Lithium-Akku
- `semFrame`, `semLoginFrame`, `SemAssembler`, `decodeSemMeasure`, `decodeSemDay`, `semView` – Zwischenstecker
- `cleanKey`, `cleanPin`, `fmtDE`, `usableLevel`, `CHARGE_STATE`

Alle Ansichten liefern dieselbe Form:
`{ stateText, stateLevel, alarm, info, plausible, check, metrics: [[Bezeichnung, Text, Einheit, Stufe], …] }`
Stufe ist `''`, `'warn'` (gelb) oder `'bad'` (rot). **Der erste Eintrag in `metrics` wird als großer Hauptwert angezeigt**, bei Einheit `%` mit Balken.

### IIFE (UI und Bluetooth)

- Anti-Framing: Läuft die Seite in einem iframe, zeigt sie nur einen Hinweis und startet nicht.
- Speicherzugriff nur über `loadMap`/`own` (nur eigene Felder, typgeprüft).
- `handleVictron` → entschlüsselt und ruft `decodeAny`.
- `connectBms`, `connectSem` → GATT-Verbindung, Abfrage alle 2 s, Wächter baut die Verbindung bei Abbruch oder 30 s Stille neu auf.
- `buildTile`/`updateTile` → Kacheln; `updateTile` läuft zusätzlich jede Sekunde (Alter der Daten).
- `layout()` → verteilt die Kachelhöhe auf den sichtbaren Bildschirm (ab 600 px Breite), ab drei Reihen Klasse `dense`.
- Anordnen (Ziehen, Pfeile, „Name“ zum Umbenennen), Hell/Dunkel, Import/Export, Diagnose mit Protokoll.

## 4. Protokolle

### Victron Instant Readout
- Herstellerdaten (Company ID `0x02E1`) aus Advertisements (`watchAdvertisements` je Gerät; `requestLEScan` gibt es in Bluefy nicht).
- Paket: `10 | Modell (2) | Typ | IV (2, LE) | erstes Schlüsselbyte | verschlüsselte Nutzdaten`.
- AES-128-CTR, Zähler = IV auf 16 Byte; umgesetzt als AES-CBC mit IV 0 je Block (WebCrypto).
- Schlüssel: 32 Hex-Zeichen aus VictronConnect (Gerät → Zahnrad → Produktinfo → Instant Readout → Details).
- Chrome braucht bei `requestDevice` `optionalManufacturerData: [0x02E1]` (eingebaut).

### JBD-BMS (LANGZEIT-Akku)
- Dienst `FF00`, Notify `FF01`, Write `FF02`.
- Nur zwei feste Lese-Anfragen: `DD A5 03 00 FF FD 77` (Basisdaten) und `DD A5 04 00 FF FC 77` (Zellen).
- Antwort `DD cmd status len data… chkH chkL 77`, Prüfsumme = `0x10000 − Summe(status, len, data)`.
- Die LANGZEIT-App darf nicht gleichzeitig verbunden sein (nur eine GATT-Verbindung).

### Voltcraft SEM6000
- Dienst `FFF0`, Write `FFF3`, Notify `FFF4`.
- Rahmen `0F | Länge | Befehl (2) | Daten | Prüfsumme | FF FF`, Prüfsumme = `(Summe Befehl+Daten + 1) & FF`.
- Ablauf: Anmeldung mit PIN (`0x17`), dann alle 2 s Messwerte (`0x04`), jede Minute 24-h-Verlauf (`0x0A`).
- Messwerte: an/aus, mW (3), V (1), mA (2), Hz (1), [2 Byte unbekannt], Gesamt Wh (4).
- Eigenheit neuerer Hardware: Längenbyte bei Messwerten um 2 zu klein, wird erkannt.
- 24-h-Verlauf: 24 × 2 Byte Wh, ältester zuerst; „Heute“ = letzte (Stunde + 1) Werte.
- Erkennung am Namen: `voltcraft`, `sem6` oder „230V“ im Namen.

## 5. Anzeige- und Rechenregeln (vom Nutzer festgelegt, nicht ohne Rückfrage ändern)

- **AGM „Rest nutzbar“** = 50 − (100 − Ladezustand), begrenzt auf 0…50 %. Bis 30 % gelb, bis 15 % rot.
- **Restlaufzeit** = nutzbare Ah ÷ Entladestrom, geglättet über etwa 1 Minute (nicht die Peukert-Zeit des SmartShunt).
- **Lithium-Ladezustand:** bis 30 % gelb, bis 15 % rot.
- **Zell-Wächter LiFePO4** je Zelle: unter Last < 3,0 V rot; in Ruhe (mindestens 5 min unter 0,5 A) < 3,2 V rot; Hysterese 0,05 V. Bei Alarm werden alle Werte der Kachel rot, die Kachel bekommt einen roten Rahmen und die Warnung steht darunter.
- **Bezeichnungen:** „Rest nutzbar“, „Zell-Delta“, „Rest von 200 Ah“, „Verbraucht“, „Ertrag heute“ (kommt vom Regler, setzt sich nachts zurück).
- **Ladezustände deutsch:** Laden (Bulk), Konstantspannung (Absorption), Erhaltungsladung (Float), Lagerung, Batterieschutz (BatterySafe), Sparmodus, Fehler, Aus.
- **Stecker-Kachel:** Leistung, Spannung, Strom, Heute, Gesamt; Zustand an/aus; Frequenz als Hinweis.

## 6. Aussehen

- Kopfzeile: Wohnmobil-Symbol, Titel, Uhrzeit und Datum, Knöpfe mit Symbolen (Anordnen, Gerät hinzufügen, Import, Hell/Dunkel). Auf dem Handy nur Symbole.
- Kachel: farbiges Symbol je Geräteart, Name, Zustand als farbiger Punkt mit Text, rechts Alter der Daten und Signalstärke.
- Geräteart als Klasse `kind-batt`, `kind-lith`, `kind-solar`, `kind-plug`, `kind-sock`, `kind-dev`; Farben über `--c` (kräftig) und `--s` (zart) je Hell/Dunkel.
- Hauptwert groß links in zart gefärbtem Feld (`.hero`), übrige Werte rechts im 3-Spalten-Raster, Wert über Bezeichnung. iPad hochkant: Hauptwert quer oben. Handy: eine Spalte.
- Warnstufen: Wert gelb bzw. rot hinterlegt; ist der Hauptwert betroffen, färben sich Feld und Balken.
- Symbole sind SVG, erzeugt mit `createElementNS` (Liste `ICONS` in `app.js`), kein `innerHTML`.
- Das PIN-Feld des Steckers erscheint nur ohne Daten oder im Anordnen-Modus.

## 7. Speicher (localStorage)

| Schlüssel | Inhalt |
|---|---|
| `victron-keys` | Victron-Schlüssel nach Geräte-ID und BLE-Name (**geheim**) |
| `victron-known` | gemerkte Geräte `{id, name}` für automatisches Verbinden |
| `victron-order` | Reihenfolge der Kacheln |
| `victron-names` | eigene Kachelnamen nach Geräte-ID |
| `victron-theme` | `light` / `dark` (ohne Eintrag: Systemeinstellung) |
| `victron-pins` | PIN des Zwischensteckers (**geheim**) |

**Konfiguration exportieren/importieren** (`obelix-config.json`): `{ "keys": {BLE-Name: Schlüssel}, "names": {BLE-Name: Kachelname} }`. Namen werden nur für schon hinzugefügte Geräte übernommen. Die PIN ist nicht im Export.

## 8. Sicherheitsregeln (verbindlich)

1. Niemals Schlüssel oder PIN ins Repo – es ist öffentlich. Auch nicht in Tests, Commits oder Screenshots (Tests nutzen nur Testschlüssel).
2. CSP bleibt streng (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; …`): keine Inline-Skripte, keine `style="…"`-Attribute, keine Netzwerkzugriffe, keine CDNs oder fremden Schriften. Stil-Eigenschaften per JavaScript (CSSOM, z. B. Balkenbreite) sind erlaubt.
3. Nur `textContent`, nie `innerHTML`, `eval` oder `document.write`.
4. Akku nur lesen: `isAllowedBmsRequest` erlaubt nur die zwei festen Anfragen. Stecker: `isAllowedSemRequest` erlaubt nur Anmeldung mit der eigenen PIN, Messwerte und Tagesverbrauch. Niemals erweitern (beide Geräte kennen Schalt- und Schreibbefehle).
5. Anti-Framing am Anfang der IIFE beibehalten.
6. Alles aus localStorage über `own()` lesen.
7. Nach Änderungen Unit-Tests und Pentest laufen lassen.

Restrisiken außerhalb des Codes: GitHub-Konto (Zwei-Faktor-Anmeldung), gemeinsamer Speicherbereich aller Seiten unter `hagi089.github.io`, Victron-Funkdaten sind nicht gegen Veränderung geschützt (nur Anzeige betroffen), Schlüssel liegen unverschlüsselt im Browser des Geräts.

## 9. Tests

```sh
node tests/unit.js                                  # 35 Unit-Tests
NODE_PATH=$(npm root -g) node tests/pentest.js      # 17 Sicherheitsprüfungen
python3 tests/screenshots.py /tmp/obelix            # Screenshots
```

- **Unit-Tests** prüfen Solar, SmartShunt (Rest nutzbar, Farben, Restlaufzeit), Ladegerät, JBD-Rahmen, Lithium-Farben, Zell-Wächter (Last, Ruhe, Hysterese, Lesefehler), SEM6000 (PIN-Rahmen, neue Hardware, Messwerte, Tagesverbrauch) und Eingabeprüfung.
- **Pentest** (Ports 8711/8712): Laden mit CSP ohne Fehler, Entschlüsselung, Akku-Daten, Stile; bösartiger Gerätename nur als Text; kein Prototype Pollution; kaputte Speicherdaten; Akku nur zwei Lese-Anfragen; Stecker nur erlaubte Befehle; CSP blockiert Inline-Skript, fremdes Skript, Datenabfluss per Bild und fetch, Inline-Stile; Hell/Dunkel; Umbenennen; Einbetten in fremde Seite.
- **Screenshots** nutzen `tests/mock-bt.js`. Szenario `normal` oder `low` (AGM 12 % nutzbar, Lithium 12 % mit Zell-Alarm).

## 10. Arbeitsablauf

1. Änderung machen; neue reine Logik in den PURE-Block und mit Unit-Test absichern.
2. Neue Messwerte als `metrics`-Einträge liefern; der erste Eintrag ist der Hauptwert.
3. Tests und Pentest laufen lassen.
4. Bei UI-Änderungen dem Nutzer vorher Screenshots zeigen, erst nach Freigabe pushen.
5. Commit auf `main` (Nachricht deutsch und knapp), Push → GitHub Pages veröffentlicht nach etwa einer Minute.

## 11. Eigenheiten Bluefy / Android

- Bluefy: kein `requestLEScan`, stattdessen `watchAdvertisements` je Gerät. `requestDevice` kann sofort werfen (`pickDevice` fängt das ab); Fallback ohne `optionalServices`; Hinweis nach 8 s ohne Auswahl.
- Gerätenamen kommen manchmal erst mit einem späteren Advertisement; `onAdv` bevorzugt `ev.name`.
- Automatisches Verbinden über `getDevices`. In Chrome auf Android muss dafür unter `chrome://flags` „Web Bluetooth new permissions backend“ aktiv sein.

## 12. Offen

- Stecker „Heute“ und „Gesamt“ mit Verbraucher gegen die Voltcraft-App vergleichen (Reihenfolge der 24-h-Werte noch ungeprüft).
- Optional: Stecker-PIN in den Konfigurations-Export aufnehmen (Entscheidung des Nutzers offen).
- Neues Aussehen auf dem echten iPad prüfen.
