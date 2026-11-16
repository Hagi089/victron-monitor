/* Unit-Tests der reinen Funktionen (PURE-Block aus app.js). Aufruf aus dem Repo-Ordner: node tests/unit.js */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const pure = src.slice(src.indexOf('/* PURE-BEGIN */'), src.indexOf('/* PURE-END */'));
const P = new Function(pure + '\nreturn { decodeSolarView, decodeBattery, decodeCharger, JbdAssembler, decodeJbdBasic, decodeJbdCells, jbdView, cellCheck, semFrame, semLoginFrame, SemAssembler, decodeSemMeasure, decodeSemDay, semView, cleanKey, cleanPin, CHARGE_STATE, usableLevel };')();
let n = 0, bad = 0;
function eq(name, a, b) { n++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { bad++; console.log('FEHLER ' + name + ': ' + JSON.stringify(a) + ' statt ' + JSON.stringify(b)); } }
function setBits(b, off, k, val) { for (let i = 0; i < k; i++) { const p = off + i; if (Math.floor(val / 2 ** i) % 2) b[p >> 3] |= 1 << (p & 7); } }
const tw = (v, k) => (v < 0 ? 2 ** k + v : v);
const m = (r, lbl) => { const x = r.metrics.find(z => z[0] === lbl); return x ? x.slice(1) : null; };

/* Solar */
let b = new Uint8Array(12); setBits(b, 0, 8, 3); setBits(b, 16, 16, 1329); setBits(b, 32, 16, 27); setBits(b, 48, 16, 84); setBits(b, 64, 16, 38); setBits(b, 80, 9, 0x1FF);
let r = P.decodeSolarView(b);
eq('Solar Zustand', r.stateText, 'Laden');
eq('Solar PV', m(r, 'PV-Leistung'), ['38', 'W']);
eq('Solar Ertrag', m(r, 'Ertrag heute'), ['0,84', 'kWh']);
eq('Zustände deutsch', [P.CHARGE_STATE[4][0], P.CHARGE_STATE[5][0], P.CHARGE_STATE[248][0]], ['Konstantspannung', 'Erhaltungsladung', 'Batterieschutz']);

/* SmartShunt: Rest nutzbar = 50 - (100 - SOC), Farben bis 30 gelb, bis 15 rot */
function shunt(soc, amps) { const x = new Uint8Array(15); setBits(x, 16, 16, 1271); setBits(x, 48, 16, 0xFFFF); setBits(x, 64, 2, 3); setBits(x, 66, 22, tw(Math.round(amps * 1000), 22)); setBits(x, 88, 20, Math.round((100 - soc) * 20)); setBits(x, 108, 10, Math.round(soc * 10)); return x; }
r = P.decodeBattery(shunt(86.4, -3.42));
eq('AGM Rest nutzbar', m(r, 'Rest nutzbar'), ['36,4', '%', '']);
eq('AGM Restlaufzeit', m(r, 'Restlaufzeit'), ['21:17', 'h']);
eq('AGM Zustand', [r.stateText, r.stateLevel], ['Entlädt', 'warn']);
eq('AGM gelb', m(P.decodeBattery(shunt(75, -1)), 'Rest nutzbar')[2], 'warn');
eq('AGM rot', m(P.decodeBattery(shunt(62, -1)), 'Rest nutzbar')[2], 'bad');
eq('AGM nie unter 0', m(P.decodeBattery(shunt(40, -1)), 'Rest nutzbar')[1], '%');
eq('AGM 0 %', m(P.decodeBattery(shunt(40, -1)), 'Rest nutzbar')[0], '0,0');

/* Ladegerät */
b = new Uint8Array(13); setBits(b, 0, 8, 5); setBits(b, 16, 13, 1360); setBits(b, 29, 11, 25); setBits(b, 40, 13, 0x1FFF); setBits(b, 53, 11, 0x7FF); setBits(b, 64, 13, 0x1FFF); setBits(b, 77, 11, 0x7FF); setBits(b, 88, 7, 65); setBits(b, 95, 9, 4);
r = P.decodeCharger(b);
eq('Ladegerät', [r.stateText, m(r, 'Batterie'), m(r, 'Ladestrom'), m(r, 'Temperatur')], ['Erhaltungsladung', ['13,60', 'V'], ['2,5', 'A'], ['25', '°C']]);

/* JBD-BMS */
function frame(cmd, data) { const f = [0xDD, cmd, 0, data.length, ...data]; let s = 0; for (let i = 2; i < f.length; i++) s += f[i]; const k = (0x10000 - s) & 0xFFFF; return [...f, k >> 8, k & 255, 0x77]; }
const u16 = v => [(v >> 8) & 255, v & 255];
function basic(soc, centiA) { return frame(3, [...u16(1328), ...u16(tw(centiA, 16)), ...u16(soc * 200), ...u16(20000), ...u16(23), 0, 0, 0, 0, 0, 0, 0, 0, 0, soc, 3, 4, 1, ...u16(2731 + 145)]); }
const asm = new P.JbdAssembler();
const fr = asm.push(basic(78, 185).concat(frame(4, [...u16(3318), ...u16(3324), ...u16(3321), ...u16(3320)])));
eq('JBD zwei Rahmen', fr.length, 2);
const bb = P.decodeJbdBasic(fr[0].data), cells = P.decodeJbdCells(fr[1].data);
r = P.jbdView(bb, cells, {}, 0);
eq('Lithium Ladezustand', m(r, 'Ladezustand'), ['78', '%', '']);
eq('Lithium Zell-Delta', m(r, 'Zell-Delta'), ['6', 'mV']);
eq('Lithium Info', r.info, '23 Ladezyklen');
eq('Lithium gelb ≤ 30', m(P.jbdView(P.decodeJbdBasic(new P.JbdAssembler().push(basic(30, 0))[0].data), cells, {}, 0), 'Ladezustand')[2], 'warn');
eq('Lithium rot ≤ 15', m(P.jbdView(P.decodeJbdBasic(new P.JbdAssembler().push(basic(15, 0))[0].data), cells, {}, 0), 'Ladezustand')[2], 'bad');

/* Zell-Wächter: unter Last < 3,0 V, in Ruhe (≥ 5 min < 0,5 A) < 3,2 V, Hysterese 0,05 V */
const load = { v: 12.6, i: -10, cells: 4 }, rest = { v: 12.8, i: 0, cells: 4 };
eq('Last 2,99 V rot', P.cellCheck(load, [2.99, 3.1, 3.1, 3.1], {}, 0).low, true);
eq('Last 3,05 V ok', P.cellCheck(load, [3.05, 3.1, 3.1, 3.1], {}, 0).low, false);
let st = {}; P.cellCheck(rest, [3.15, 3.3, 3.3, 3.3], st, 0);
eq('Ruhe vor 5 min ok', P.cellCheck(rest, [3.15, 3.3, 3.3, 3.3], st, 60000).low, false);
[120000, 180000, 240000].forEach(t => P.cellCheck(rest, [3.15, 3.3, 3.3, 3.3], st, t));
eq('Ruhe nach 5 min rot', P.cellCheck(rest, [3.15, 3.3, 3.3, 3.3], st, 300000).low, true);
eq('Hysterese hält rot', P.cellCheck(rest, [3.22, 3.3, 3.3, 3.3], st, 301000).low, true);
eq('Hysterese gibt frei', P.cellCheck(rest, [3.26, 3.3, 3.3, 3.3], st, 302000).low, false);
eq('Lesefehler 0 V kein Alarm', P.cellCheck(load, [0, 3.3, 3.3, 3.3], {}, 0).low, false);
const alarmView = P.jbdView(bb, [2.95, 3.3, 3.3, 3.3], {}, 0);
eq('Zell-Alarm: alle Werte rot', alarmView.metrics.every(x => x[3] === 'bad'), true);
eq('Zell-Alarm: Text', /Zellspannung zu niedrig/.test(alarmView.alarm), true);

/* SEM6000 */
eq('SEM Login-Rahmen', P.semLoginFrame('1234'), [15, 12, 23, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0, 34, 255, 255]);
eq('SEM PIN ungültig', P.semLoginFrame('12a4'), null);
const s = new P.SemAssembler();
/* neuere Hardware: Längenbyte um 2 zu klein */
const body = [0x04, 0x00, 1, 0x06, 0x49, 0x60, 231, 0x07, 0x44, 50, 0, 0, 0x96, 0xD1];
let sum = 1; body.forEach(x => { sum += x; });
const sf = s.push([0x0F, body.length + 1 - 2, ...body, sum & 255, 0xFF, 0xFF]);
eq('SEM neue Hardware erkannt', [sf.length, sf[0] && sf[0].newHw], [1, true]);
const meas = P.decodeSemMeasure(sf[0].data, sf[0].newHw);
eq('SEM Messwerte', [meas.on, meas.w, meas.v, meas.a, meas.hz, meas.totalWh], [true, 412, 231, 1.86, 50, 38609]);
const hours = []; for (let i = 0; i < 24; i++) hours.push(0, i >= 20 ? 100 : 0);
eq('SEM Heute (Stunde 3 → letzte 4 Werte)', P.decodeSemDay(hours, 3).todayWh, 400);
eq('SEM Ansicht', P.semView(meas, { todayWh: 400 }).metrics.map(x => x[1] + ' ' + x[2]), ['412 W', '231 V', '1,86 A', '400 Wh', '38,61 kWh']);

/* Eingaben */
eq('Schlüssel säubern', P.cleanKey(' 0F1E 2D3C4B5A69788796A5B4C3D2E1F0 '), '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
eq('Schlüssel zu kurz', P.cleanKey('abc'), null);

console.log((n - bad) + ' von ' + n + ' Unit-Tests bestanden');
process.exit(bad ? 1 : 0);
