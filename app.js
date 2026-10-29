/* PURE-BEGIN */
function hexToBytes(h) {
  var out = new Uint8Array(h.length / 2);
  for (var i = 0; i < out.length; i++) { out[i] = parseInt(h.substr(i * 2, 2), 16); }
  return out;
}
function cleanKey(s) {
  var h = String(s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return h.length === 32 ? h : null;
}
/* Bits werden von unten (LSB zuerst) gelesen, bis 31 Bit Breite. */
function bitsLE(bytes, offset, n) {
  var v = 0;
  for (var i = 0; i < n; i++) {
    var pos = offset + i;
    var bit = (bytes[pos >> 3] >> (pos & 7)) & 1;
    v += bit * Math.pow(2, i);
  }
  return v;
}
function signed(v, n) { return v >= Math.pow(2, n - 1) ? v - Math.pow(2, n) : v; }

var CHARGE_STATE = {
  0: ['Aus', ''], 1: ['Sparmodus', 'warn'], 2: ['Fehler', 'bad'], 3: ['Bulk', 'ok'], 4: ['Absorption', 'ok'],
  5: ['Float', 'ok'], 6: ['Lagerung', 'ok'], 7: ['Ausgleich (manuell)', 'ok'], 9: ['Wechselrichter', 'ok'],
  11: ['Netzteil', 'ok'], 245: ['Startet', 'warn'], 246: ['Absorption (wiederholt)', 'ok'],
  247: ['Auto-Ausgleich', 'ok'], 248: ['BatterySafe', 'warn'], 252: ['Externe Steuerung', 'warn']
};

/* Solar-Laderegler, Datensatztyp 0x01 */
function decodeSolar(b) {
  var state = bitsLE(b, 0, 8);
  var err = bitsLE(b, 8, 8);
  var load = bitsLE(b, 80, 9);
  var st = CHARGE_STATE[state] || ['Zustand ' + state, 'warn'];
  return {
    kind: 'solar',
    stateText: st[0], stateLevel: st[1],
    error: err,
    vBat: signed(bitsLE(b, 16, 16), 16) / 100,
    iBat: signed(bitsLE(b, 32, 16), 16) / 10,
    yieldWh: bitsLE(b, 48, 16) * 10,
    pvW: bitsLE(b, 64, 16),
    loadA: load === 0x1FF ? null : load / 10
  };
}

function fmtDE(n, d) { return n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }); }

/* Einheitliche Form: { stateText, stateLevel, alarm, plausible, metrics: [[Label, Text, Einheit], ...] } */
function decodeSolarView(b) {
  var r = decodeSolar(b);
  var m = [
    ['PV-Leistung', fmtDE(r.pvW, 0), 'W'],
    ['Batterie', fmtDE(r.vBat, 2), 'V'],
    ['Ladestrom', fmtDE(r.iBat, 1), 'A'],
    ['Ertrag heute', fmtDE(r.yieldWh / 1000, 2), 'kWh']
  ];
  if (r.loadA !== null) { m.push(['Lastausgang', fmtDE(r.loadA, 1), 'A']); }
  return {
    stateText: r.stateText, stateLevel: r.stateLevel,
    alarm: r.error ? 'Fehlercode ' + r.error : '',
    plausible: r.vBat > 5 && r.vBat < 70 && !!CHARGE_STATE[bitsLE(b, 0, 8)] && r.pvW < 5000 && Math.abs(r.iBat) < 200,
    check: 'Batterie ' + fmtDE(r.vBat, 2) + ' V',
    metrics: m
  };
}

/* Nennkapazität der Batterie am SmartShunt in Ah (steht nicht in den Funkdaten, hier einstellen) */
var BATTERY_AH = 200;
/* Bei der AGM-Batterie sind nur etwa 50 % der Energie tatsächlich nutzbar (nicht tiefer als 50 % entladen).
   Nutzbar = 50 - (100 - Ladezustand), also 50 % bei voller Batterie und 0 % bei 50 % Ladezustand. */
var USABLE_PERCENT = 50;
/* Farbstufen der Anzeige "Tatsächlich nutzbar": bis 30 % gelb, bis 15 % rot */
var USABLE_WARN = 30, USABLE_BAD = 15;
function usableLevel(u) { return u <= USABLE_BAD ? 'bad' : (u <= USABLE_WARN ? 'warn' : ''); }

/* Batteriemonitor (SmartShunt, BMV), Datensatztyp 0x02 */
function decodeBattery(b) {
  var ttg = bitsLE(b, 0, 16);
  var v = signed(bitsLE(b, 16, 16), 16) / 100;
  var alarm = bitsLE(b, 32, 16);
  var aux = bitsLE(b, 48, 16);
  var auxMode = bitsLE(b, 64, 2);
  var iRaw = bitsLE(b, 66, 22);
  var cRaw = bitsLE(b, 88, 20);
  var socRaw = bitsLE(b, 108, 10);
  var i = iRaw === 0x1FFFFF ? null : signed(iRaw, 22) / 1000;
  var soc = socRaw === 0x3FF ? null : socRaw / 10;
  var consumed = cRaw === 0xFFFFF ? null : -cRaw / 10;
  var usable = soc === null ? null : Math.max(0, Math.min(USABLE_PERCENT, USABLE_PERCENT - (100 - soc)));
  var m = [];
  m.push(['Ladezustand', soc === null ? '–' : fmtDE(soc, 1), soc === null ? '' : '%']);
  m.push(['Batterie', fmtDE(v, 2), 'V']);
  if (i !== null) {
    m.push(['Strom', (i > 0 ? '+' : '') + fmtDE(i, 2), 'A']);
    m.push(['Leistung', (i > 0 ? '+' : '') + fmtDE(i * v, 0), 'W']);
  }
  if (consumed !== null) {
    /* Rest = Nennkapazität minus Verbrauch (Verbrauch ist negativ gemeldet), begrenzt auf 0 bis Nennkapazität */
    var rest = Math.max(0, Math.min(BATTERY_AH, BATTERY_AH + consumed));
    m.push(['Rest von ' + fmtDE(BATTERY_AH, 0) + ' Ah', fmtDE(rest, 1), 'Ah']);
    if (usable !== null) { m.push(['Tatsächlich nutzbar', fmtDE(usable, 1), '%', usableLevel(usable)]); }
    m.push(['Verbraucht', fmtDE(consumed, 1), 'Ah']);
  } else if (usable !== null) {
    m.push(['Tatsächlich nutzbar', fmtDE(usable, 1), '%', usableLevel(usable)]);
  }
  if (ttg === 0xFFFF) { m.push(['Restlaufzeit', '∞', '']); }
  else { m.push(['Restlaufzeit', Math.floor(ttg / 60) + ':' + ('0' + (ttg % 60)).slice(-2), 'h']); }
  if (auxMode === 0 && aux !== 0xFFFF) { m.push(['Starterbatterie', fmtDE(signed(aux, 16) / 100, 2), 'V']); }
  if (auxMode === 1 && aux !== 0xFFFF) { m.push(['Mittelpunkt', fmtDE(aux / 100, 2), 'V']); }
  if (auxMode === 2 && aux !== 0xFFFF) { m.push(['Temperatur', fmtDE(aux / 100 - 273.15, 1), '°C']); }
  var st, lvl;
  if (i === null || Math.abs(i) < 0.05) { st = 'Ruhe'; lvl = ''; }
  else if (i > 0) { st = 'Lädt'; lvl = 'ok'; }
  else { st = 'Entlädt'; lvl = 'warn'; }
  if (soc !== null && soc < 20) { lvl = 'bad'; }
  return {
    stateText: st, stateLevel: lvl,
    alarm: alarm ? 'Alarm aktiv (Code ' + alarm + ')' : '',
    plausible: v > 5 && v < 70 && (soc === null || soc <= 100) && (i === null || Math.abs(i) < 1000),
    check: 'Batterie ' + fmtDE(v, 2) + ' V' + (soc !== null ? ', ' + fmtDE(soc, 0) + ' %' : ''),
    metrics: m
  };
}

/* AC-Ladegerät (Blue Smart IP65/IP67/IP22), Datensatztyp 0x08 */
function decodeCharger(b) {
  var state = bitsLE(b, 0, 8);
  var err = bitsLE(b, 8, 8);
  var outs = [];
  for (var k = 0; k < 3; k++) {
    var vr = bitsLE(b, 16 + k * 24, 13);
    var ir = bitsLE(b, 29 + k * 24, 11);
    outs.push({ v: vr === 0x1FFF ? null : vr / 100, i: ir === 0x7FF ? null : ir / 10 });
  }
  var tRaw = bitsLE(b, 88, 7);
  var acRaw = bitsLE(b, 95, 9);
  var st = CHARGE_STATE[state] || ['Zustand ' + state, 'warn'];
  var m = [];
  outs.forEach(function (o, idx) {
    var suffix = idx === 0 ? '' : ' ' + (idx + 1);
    if (o.v !== null) { m.push(['Batterie' + suffix, fmtDE(o.v, 2), 'V']); }
    if (o.i !== null) { m.push(['Ladestrom' + suffix, fmtDE(o.i, 1), 'A']); }
  });
  if (outs[0].v !== null && outs[0].i !== null) { m.push(['Leistung', fmtDE(outs[0].v * outs[0].i, 0), 'W']); }
  if (tRaw !== 0x7F) { m.push(['Temperatur', fmtDE(tRaw - 40, 0), '°C']); }
  if (acRaw !== 0x1FF) { m.push(['Netzstrom', fmtDE(acRaw / 10, 1), 'A']); }
  var v1 = outs[0].v;
  return {
    stateText: st[0], stateLevel: st[1],
    alarm: err ? 'Fehlercode ' + err : '',
    plausible: (v1 === null || (v1 > 5 && v1 < 70)) && !!CHARGE_STATE[state],
    check: v1 === null ? st[0] : 'Batterie ' + fmtDE(v1, 2) + ' V',
    metrics: m
  };
}

function decodeAny(type, b) {
  if (type === 0x01 && b.length >= 12) { return decodeSolarView(b); }
  if (type === 0x02 && b.length >= 15) { return decodeBattery(b); }
  if (type === 0x08 && b.length >= 13) { return decodeCharger(b); }
  return null;
}

/* JBD-BMS (Xiaoxiang, u. a. in LANGZEIT-Akkus). Antwortrahmen: DD cmd status len data... chkH chkL 77 */
var JBD_REQ_BASIC = [0xDD, 0xA5, 0x03, 0x00, 0xFF, 0xFD, 0x77];
var JBD_REQ_CELLS = [0xDD, 0xA5, 0x04, 0x00, 0xFF, 0xFC, 0x77];
function JbdAssembler() { this.buf = []; this.bad = 0; }
/* Prüfsumme der Antwort: 0x10000 minus (Status + Länge + Daten) */
function jbdChecksumOk(f, need) {
  var sum = 0;
  for (var i = 2; i < need - 3; i++) { sum += f[i]; }
  var chk = (f[need - 3] << 8) | f[need - 2];
  return ((0x10000 - sum) & 0xFFFF) === chk;
}
JbdAssembler.prototype.push = function (bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i++) { this.buf.push(bytes[i]); }
  for (;;) {
    while (this.buf.length && this.buf[0] !== 0xDD) { this.buf.shift(); }
    if (this.buf.length < 4) { break; }
    var need = 4 + this.buf[3] + 3;
    if (this.buf.length < need) { break; }
    var f = this.buf.slice(0, need);
    if (f[need - 1] === 0x77 && jbdChecksumOk(f, need)) {
      this.buf = this.buf.slice(need);
      out.push({ cmd: f[1], status: f[2], data: f.slice(4, 4 + f[3]) });
    } else {
      /* kaputter Rahmen oder falscher Start: ein Byte weiter und neu suchen */
      this.bad += 1;
      this.buf.shift();
    }
  }
  if (this.buf.length > 512) { this.buf = []; }
  return out;
};
function u16(d, o) { return (d[o] << 8) | d[o + 1]; }
function s16(d, o) { var v = u16(d, o); return v >= 0x8000 ? v - 0x10000 : v; }
function decodeJbdBasic(d) {
  if (d.length < 23) { return null; }
  var r = {
    v: u16(d, 0) / 100, i: s16(d, 2) / 100, rem: u16(d, 4) / 100, nom: u16(d, 6) / 100,
    cycles: u16(d, 8), prot: u16(d, 16), soc: d[19], fet: d[20], cells: d[21], temps: []
  };
  for (var k = 0; k < d[22] && 24 + 2 * k < d.length; k++) { r.temps.push((u16(d, 23 + 2 * k) - 2731) / 10); }
  return r;
}
function decodeJbdCells(d) {
  var c = [];
  for (var o = 0; o + 1 < d.length; o += 2) { c.push(u16(d, o) / 1000); }
  return c;
}
var JBD_PROT = ['Zelle Überspannung', 'Zelle Unterspannung', 'Akku Überspannung', 'Akku Unterspannung',
  'Laden zu warm', 'Laden zu kalt', 'Entladen zu warm', 'Entladen zu kalt', 'Ladestrom zu hoch',
  'Entladestrom zu hoch', 'Kurzschluss', 'BMS-Fehler', 'MOSFET gesperrt'];
function jbdView(b, cells) {
  var m = [];
  m.push(['Ladezustand', String(b.soc), '%']);
  m.push(['Batterie', fmtDE(b.v, 2), 'V']);
  m.push(['Strom', (b.i > 0 ? '+' : '') + fmtDE(b.i, 2), 'A']);
  m.push(['Leistung', (b.i > 0 ? '+' : '') + fmtDE(b.i * b.v, 0), 'W']);
  m.push(['Rest von ' + fmtDE(b.nom, 0) + ' Ah', fmtDE(b.rem, 1), 'Ah']);
  if (b.temps.length) { m.push(['Temperatur', fmtDE(Math.max.apply(null, b.temps), 1), '°C']); }
  if (cells && cells.length) {
    var mn = Math.min.apply(null, cells), mx = Math.max.apply(null, cells);
    m.push(['Zelle min', fmtDE(mn, 3), 'V']);
    m.push(['Zelldifferenz', fmtDE((mx - mn) * 1000, 0), 'mV']);
  }
  var alarms = [];
  JBD_PROT.forEach(function (t, k) { if (b.prot & (1 << k)) { alarms.push(t); } });
  if (!(b.fet & 1)) { alarms.push('Laden abgeschaltet'); }
  if (!(b.fet & 2)) { alarms.push('Entladen abgeschaltet'); }
  var st, lvl;
  if (Math.abs(b.i) < 0.05) { st = 'Ruhe'; lvl = ''; } else if (b.i > 0) { st = 'Lädt'; lvl = 'ok'; } else { st = 'Entlädt'; lvl = 'warn'; }
  if (b.soc < 20) { lvl = 'bad'; }
  return { stateText: st, stateLevel: lvl, alarm: alarms.join(' · '), info: b.cycles + ' Ladezyklen', plausible: true, check: '', metrics: m };
}

function counterBlock(iv, i) {
  var c = new Uint8Array(16);
  c[0] = iv & 255; c[1] = (iv >> 8) & 255;
  var carry = i;
  for (var j = 15; j >= 0 && carry; j--) { var s = c[j] + carry; c[j] = s & 255; carry = s >> 8; }
  return c;
}
/* AES-128-CTR, Zähler = 2-Byte-IV (little endian) auf 16 Byte aufgefüllt. Den Schlüsselstrom liefert AES-CBC mit IV 0 auf einem Block. */
function decryptPayload(subtle, cryptoKey, iv, enc) {
  var blocks = Math.ceil(enc.length / 16);
  var jobs = [];
  for (var i = 0; i < blocks; i++) {
    jobs.push(subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, cryptoKey, counterBlock(iv, i)));
  }
  return Promise.all(jobs).then(function (res) {
    var out = new Uint8Array(enc.length);
    for (var k = 0; k < enc.length; k++) {
      out[k] = enc[k] ^ new Uint8Array(res[k >> 4])[k & 15];
    }
    return out;
  });
}
/* PURE-END */

(function () {
  /* Läuft die Seite eingebettet in einer fremden Seite (iframe), startet sie nicht */
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (framed) {
    document.body.textContent = 'Diese Seite darf nur direkt geöffnet werden.';
    return;
  }
  var VICTRON_ID = 0x02E1;
  var devices = {};
  var logLines = [];
  var el = function (id) { return document.getElementById(id); };
  var subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
  var keyCache = {};

  function log(msg) {
    var t = new Date().toLocaleTimeString('de-DE');
    logLines.push(t + '  ' + msg);
    if (logLines.length > 150) { logLines.shift(); }
    var ta = el('log');
    ta.value = logLines.join('\n');
    ta.scrollTop = ta.scrollHeight;
  }
  function setStatus(t) { el('status').textContent = t; }

  /* ---------- Gespeicherte Daten sicher lesen ---------- */
  /* Liest ein JSON-Objekt aus localStorage. Nur einfache Objekte; Fehler ergeben ein leeres Objekt. */
  function loadMap(name) {
    var v;
    try { v = JSON.parse(localStorage.getItem(name) || '{}'); } catch (e) { return {}; }
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }
  /* Nur eigene Felder zurückgeben, nichts Geerbtes (Gerätenamen kommen per Funk und sind fremde Eingaben) */
  function own(map, k) {
    return (typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k)) ? map[k] : undefined;
  }

  /* ---------- Schlüssel ---------- */
  function loadKeys() { return loadMap('victron-keys'); }
  function storeKey(rec, hex) {
    var k = loadKeys();
    k[rec.id] = hex;
    if (rec.name) { k[rec.name] = hex; }
    try { localStorage.setItem('victron-keys', JSON.stringify(k)); } catch (e) { log('Schlüssel konnte nicht gespeichert werden'); }
  }
  function findKey(rec) {
    var k = loadKeys();
    return cleanKey(own(k, rec.id)) || cleanKey(own(k, rec.name));
  }
  function cryptoKeyFor(hex) {
    if (!keyCache[hex]) {
      keyCache[hex] = subtle.importKey('raw', hexToBytes(hex), { name: 'AES-CBC' }, false, ['encrypt']);
    }
    return keyCache[hex];
  }

  /* ---------- Victron-Paket ---------- */
  function handleVictron(rec, b) {
    if (b.length < 9 || b[0] !== 0x10) { return; }
    rec.lastBytes = b;
    rec.pkt = { model: b[2] | (b[3] << 8), type: b[4], iv: b[5] | (b[6] << 8), check: b[7], len: b.length - 8 };
    rec.pktAt = Date.now();
    var hex = findKey(rec);
    if (!hex) { rec.keyState = 'none'; updateTile(rec); return; }
    if (!subtle) { rec.keyState = 'nocrypto'; updateTile(rec); return; }
    if (parseInt(hex.substr(0, 2), 16) !== rec.pkt.check) { rec.keyState = 'mismatch'; rec.readout = null; updateTile(rec); return; }
    if (rec.busy) { return; }
    rec.busy = true;
    var enc = b.slice(8);
    var iv = rec.pkt.iv;
    var type = rec.pkt.type;
    cryptoKeyFor(hex).then(function (ck) {
      return decryptPayload(subtle, ck, iv, enc);
    }).then(function (plain) {
      rec.keyState = 'ok';
      var view = decodeAny(type, plain);
      if (view) {
        rec.readout = view;
        rec.readoutAt = Date.now();
        rec.unsupported = null;
      } else {
        rec.readout = null;
        rec.unsupported = type;
      }
      rec.busy = false;
      updateTile(rec);
    }).catch(function (e) {
      rec.busy = false;
      rec.keyState = 'error';
      log('Entschlüsselung: ' + e);
      updateTile(rec);
    });
  }

  function testKey(rec, hex, out) {
    var b = rec.lastBytes;
    if (!b || !subtle) { out.className = 'note'; out.textContent = '32 Zeichen. Prüfen geht erst, wenn eine Meldung des Geräts da ist.'; return; }
    if (parseInt(hex.substr(0, 2), 16) !== b[7]) { out.className = 'note bad'; out.textContent = 'Passt nicht: Der Schlüssel muss mit ' + b[7].toString(16) + ' beginnen.'; return; }
    cryptoKeyFor(hex).then(function (ck) {
      return decryptPayload(subtle, ck, b[5] | (b[6] << 8), b.slice(8));
    }).then(function (plain) {
      var r = decodeAny(b[4], plain);
      var plausible = !r || r.plausible;
      if (plausible) {
        out.className = 'note ok';
        out.textContent = r ? 'Passt: ' + r.check + '. Jetzt Speichern tippen.' : 'Erster Teil passt. Jetzt Speichern tippen.';
      } else {
        out.className = 'note bad';
        out.textContent = 'Ergibt unsinnige Werte, vermutlich vertippt. Prüfe besonders 0 und o, b und 6, 8 und B.';
      }
    }).catch(function (e) { out.className = 'note bad'; out.textContent = 'Prüfen fehlgeschlagen: ' + e; });
  }

  /* ---------- Kacheln ---------- */
  function fmt(n, d) { return n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }); }

  function metric(label) {
    var m = document.createElement('div'); m.className = 'metric';
    var l = document.createElement('div'); l.className = 'lbl'; l.textContent = label;
    var v = document.createElement('div'); v.className = 'val';
    var num = document.createElement('span');
    var unit = document.createElement('small');
    v.appendChild(num); v.appendChild(unit);
    m.appendChild(l); m.appendChild(v);
    return { box: m, num: num, unit: unit };
  }

  /* Eigene Anzeigenamen (Gerätename bleibt unverändert, er wird zum Verbinden gebraucht) */
  function loadNames() { return loadMap('victron-names'); }
  function displayName(rec) {
    var n = own(loadNames(), rec.id);
    return (typeof n === 'string' && n ? n.slice(0, 40) : '') || rec.name || 'Victron-Gerät';
  }
  function setCustomName(id, name) {
    var n = loadNames();
    if (name) { n[id] = name; } else { delete n[id]; }
    try { localStorage.setItem('victron-names', JSON.stringify(n)); } catch (e) { /* egal */ }
  }
  function startRename(rec, ui) {
    if (ui.renaming) { return; }
    var inp = document.createElement('input');
    inp.type = 'text'; inp.maxLength = 40; inp.value = displayName(rec); inp.placeholder = rec.name || '';
    inp.setAttribute('aria-label', 'Name der Kachel');
    inp.setAttribute('autocomplete', 'off'); inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('spellcheck', 'false');
    ui.renaming = true;
    ui.name.textContent = '';
    ui.name.appendChild(inp);
    function done(save) {
      if (!ui.renaming) { return; }
      ui.renaming = false;
      if (save) { setCustomName(rec.id, inp.value.replace(/^\s+|\s+$/g, '')); log('Name geändert: ' + displayName(rec)); }
      updateTile(rec);
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { done(true); } else if (e.key === 'Escape') { done(false); }
    });
    inp.addEventListener('blur', function () { done(true); });
    inp.focus();
    try { inp.select(); } catch (e) { /* egal */ }
  }

  function buildTile(rec) {
    var ui = {};
    var tile = document.createElement('article'); tile.className = 'tile';
    var head = document.createElement('div'); head.className = 'tile-head';
    var left = document.createElement('div'); left.style.minWidth = '0';
    ui.name = document.createElement('div'); ui.name.className = 'tile-name';
    ui.sub = document.createElement('div'); ui.sub.className = 'tile-sub';
    left.appendChild(ui.name); left.appendChild(ui.sub);
    ui.pill = document.createElement('span'); ui.pill.className = 'pill';
    head.appendChild(left); head.appendChild(ui.pill);
    tile.appendChild(head);

    ui.connect = document.createElement('button');
    ui.connect.type = 'button';
    ui.connect.textContent = 'Verbinden';
    ui.connect.style.marginTop = '12px';
    ui.connect.style.width = '100%';
    ui.connect.addEventListener('click', function () { reconnect(rec); });
    tile.appendChild(ui.connect);

    tile.dataset.id = rec.id;
    var arr = document.createElement('div'); arr.className = 'arr';
    var bPrev = document.createElement('button'); bPrev.type = 'button'; bPrev.className = 'secondary'; bPrev.textContent = '◀'; bPrev.setAttribute('aria-label', 'Nach vorne');
    var bDrag = document.createElement('button'); bDrag.type = 'button'; bDrag.className = 'secondary handle'; bDrag.textContent = 'Ziehen';
    var bNext = document.createElement('button'); bNext.type = 'button'; bNext.className = 'secondary'; bNext.textContent = '▶'; bNext.setAttribute('aria-label', 'Nach hinten');
    var bName = document.createElement('button'); bName.type = 'button'; bName.className = 'secondary'; bName.textContent = 'Name'; bName.setAttribute('aria-label', 'Kachel umbenennen');
    arr.appendChild(bPrev); arr.appendChild(bDrag); arr.appendChild(bNext); arr.appendChild(bName);
    tile.appendChild(arr);
    bPrev.addEventListener('click', function () { moveTile(tile, -1); });
    bNext.addEventListener('click', function () { moveTile(tile, 1); });
    bName.addEventListener('click', function () { startRename(rec, ui); });
    startDrag(bDrag, tile);

    ui.metrics = document.createElement('div'); ui.metrics.className = 'metrics';
    ui.metricKey = '';
    ui.metricEls = [];
    tile.appendChild(ui.metrics);

    ui.note = document.createElement('p'); ui.note.className = 'note';
    tile.appendChild(ui.note);

    ui.keyBox = document.createElement('details'); ui.keyBox.className = 'key';
    var sum = document.createElement('summary'); sum.textContent = 'Schlüssel';
    ui.keyBox.appendChild(sum);
    var hint = document.createElement('p'); hint.className = 'note';
    hint.textContent = 'In VictronConnect: Gerät öffnen, Zahnrad, Produktinfo, Instant Readout, „Details anzeigen“. Die 32 Zeichen hier einfügen.';
    ui.keyBox.appendChild(hint);
    var row = document.createElement('div'); row.className = 'keyrow';
    ui.input = document.createElement('input');
    ui.input.type = 'password';
    ui.input.id = 'key-' + rec.id.replace(/[^a-zA-Z0-9]/g, '');
    ui.input.setAttribute('autocomplete', 'off');
    ui.input.setAttribute('autocapitalize', 'off');
    ui.input.setAttribute('autocorrect', 'off');
    ui.input.setAttribute('spellcheck', 'false');
    ui.input.placeholder = '32 Zeichen (0-9, a-f)';
    ui.save = document.createElement('button'); ui.save.type = 'button'; ui.save.textContent = 'Speichern';
    row.appendChild(ui.input); row.appendChild(ui.save);
    ui.keyBox.appendChild(row);
    ui.keyMsg = document.createElement('p'); ui.keyMsg.className = 'note';
    ui.keyBox.appendChild(ui.keyMsg);
    tile.appendChild(ui.keyBox);

    ui.input.addEventListener('input', function () {
      var raw = String(ui.input.value || '').replace(/[^0-9a-fA-F]/g, '');
      if (raw.length < 32) {
        ui.keyMsg.className = 'note';
        ui.keyMsg.textContent = raw.length + ' von 32 Zeichen' + (raw.length >= 2 && rec.pkt && parseInt(raw.substr(0, 2), 16) !== rec.pkt.check ? ' · Anfang passt nicht, er muss mit ' + rec.pkt.check.toString(16) + ' beginnen' : '');
        return;
      }
      if (raw.length > 32) { ui.keyMsg.className = 'note bad'; ui.keyMsg.textContent = raw.length + ' Zeichen, das sind zu viele.'; return; }
      testKey(rec, raw.toLowerCase(), ui.keyMsg);
    });
    ui.save.addEventListener('click', function () {
      var hex = cleanKey(ui.input.value);
      if (!hex) { ui.keyMsg.className = 'note bad'; ui.keyMsg.textContent = 'Der Schlüssel braucht genau 32 Zeichen aus 0-9 und a-f.'; return; }
      storeKey(rec, hex);
      ui.input.value = '';
      ui.keyMsg.className = 'note ok';
      ui.keyMsg.textContent = 'Gespeichert. Die Werte erscheinen mit der nächsten Meldung.';
      rec.keyState = null;
      log('Schlüssel gespeichert für ' + (rec.name || rec.id));
    });

    el('tiles').appendChild(tile);
    applyOrder();
    var empty = el('emptyTiles'); if (empty) { empty.hidden = true; }
    var lead = el('lead'); if (lead) { lead.hidden = true; }
    setTimeout(layout, 0);
    ui.tile = tile;
    return ui;
  }

  /* Vierter Wert einer Messgröße (optional): Farbstufe 'warn' (gelb) oder 'bad' (rot) */
  function setMetric(m, text, unit, level) {
    m.num.textContent = text; m.unit.textContent = unit || '';
    m.box.className = 'metric' + (level === 'warn' || level === 'bad' ? ' ' + level : '');
  }

  function updateTile(rec) {
    if (!rec.ui) { rec.ui = buildTile(rec); rec.keyOpened = false; }
    var ui = rec.ui;
    var now = Date.now();
    if (!ui.renaming) { ui.name.textContent = displayName(rec); }
    var age = rec.pktAt ? Math.round((now - rec.pktAt) / 1000) : null;
    ui.sub.textContent = (rec.rssi !== null && rec.rssi !== undefined ? rec.rssi + ' dBm · ' : '') + (age === null ? 'noch keine Messdaten' : 'vor ' + age + ' s');
    var stale = age === null || age > 15;
    ui.tile.className = 'tile' + (stale ? ' stale' : '');
    ui.connect.hidden = !(age === null || age > 30);

    var r = rec.readout;
    var ks = rec.keyState;
    ui.metrics.hidden = !(r && ks === 'ok');
    if (r && ks === 'ok') {
      var key = r.metrics.map(function (x) { return x[0]; }).join('|');
      if (key !== ui.metricKey) {
        ui.metrics.textContent = '';
        ui.metricEls = r.metrics.map(function (x) { var mm = metric(x[0]); ui.metrics.appendChild(mm.box); return mm; });
        ui.metricKey = key;
      }
      r.metrics.forEach(function (x, idx) { setMetric(ui.metricEls[idx], x[1], x[2], x[3]); });
      ui.pill.textContent = r.stateText;
      ui.pill.className = 'pill' + (r.stateLevel ? ' ' + r.stateLevel : '');
      if (r.alarm) { ui.note.className = 'note bad'; ui.note.textContent = r.alarm; }
      else { ui.note.className = 'note'; ui.note.textContent = ''; }
    } else {
      ui.pill.textContent = '';
      ui.pill.className = 'pill';
    }

    var msg = '', cls = 'note';
    if (ks === 'none' || ks === null || ks === undefined) {
      if (rec.pkt) { msg = 'Für dieses Gerät fehlt noch der Schlüssel. Trage ihn unten bei „Schlüssel“ ein.'; }
      else if (!watched[rec.id]) { msg = 'Nicht verbunden. Tippe auf „Verbinden“.'; }
      else { msg = 'Warte auf die erste Meldung des Geräts.'; }
    } else if (ks === 'mismatch') {
      msg = 'Dieser Schlüssel passt nicht zum Gerät. Er muss mit ' + (rec.pkt.check < 16 ? '0' : '') + rec.pkt.check.toString(16) + ' beginnen.'; cls = 'note bad';
    } else if (ks === 'nocrypto') {
      msg = 'Dieser Browser bietet keine Entschlüsselung.'; cls = 'note bad';
    } else if (ks === 'error') {
      msg = 'Entschlüsselung fehlgeschlagen. Details im Protokoll der Diagnose.'; cls = 'note bad';
    } else if (ks === 'ok' && rec.unsupported !== null && rec.unsupported !== undefined) {
      msg = 'Gerätetyp 0x' + rec.unsupported.toString(16) + ' wird noch nicht ausgewertet.'; cls = 'note';
      ui.pill.textContent = 'Typ 0x' + rec.unsupported.toString(16);
    }
    if (rec.kind === 'bms') {
      ui.keyBox.hidden = true;
      if (rec.bmsMsg) { msg = rec.bmsMsg; cls = 'note'; }
      else if (r && !r.alarm) { msg = r.info; cls = 'note'; }
      else if (!watched[rec.id]) { msg = 'Nicht verbunden. Tippe auf „Verbinden“.'; cls = 'note'; }
      else { msg = ''; }
      if (!msg && !(r && r.alarm)) { ui.note.textContent = ''; }
    }
    if (msg) { ui.note.className = cls; ui.note.textContent = msg; }
    if (rec.kind === 'bms') { return; }

    ui.keyBox.hidden = ks === 'ok';
    var needKey = !(ks === 'ok');
    if (needKey && rec.pkt && !rec.keyOpened) { ui.keyBox.open = true; rec.keyOpened = true; }
    if (ks === 'ok' && rec.keyOpened) { ui.keyBox.open = false; rec.keyOpened = false; }
  }

  /* ---------- Empfang ---------- */
  function bytesFrom(v) {
    if (v instanceof DataView) { return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
    if (v instanceof ArrayBuffer) { return new Uint8Array(v); }
    if (v && v.buffer instanceof ArrayBuffer) { return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength); }
    return null;
  }
  function hexOf(u) {
    var o = [];
    for (var i = 0; i < u.length; i++) { o.push((u[i] < 16 ? '0' : '') + u[i].toString(16)); }
    return o.join(' ');
  }

  function onAdv(ev) {
    var dev = ev.device || {};
    var id = dev.id || dev.name || 'unbekannt';
    var rec = devices[id];
    if (!rec) {
      rec = devices[id] = { id: id, name: ev.name || dev.name || '', rssi: null, count: 0, last: 0, mfr: [], victron: false, types: {} };
      log('Neu: ' + (rec.name || id));
    }
    rec.count += 1;
    rec.last = Date.now();
    if (typeof ev.rssi === 'number') { rec.rssi = ev.rssi; }
    var fresh = ev.name || dev.name;
    if (fresh && fresh !== rec.name) {
      log('Gerätename: ' + (rec.name || '(leer)') + ' → ' + fresh);
      rec.name = fresh;
      updateKnownName(rec.id, fresh);
      if (rec.ui) { updateTile(rec); }
    }

    var found = [];
    var md = ev.manufacturerData;
    if (md && typeof md.forEach === 'function' && typeof md.size === 'number') {
      md.forEach(function (dv, key) { var u = bytesFrom(dv); if (u) { found.push({ company: key, data: u }); } });
    } else if (md) {
      var u = bytesFrom(md);
      if (u && u.length >= 2) { found.push({ company: u[0] | (u[1] << 8), data: u.slice(2) }); }
    }
    rec.mfr = [];
    found.forEach(function (f) {
      rec.mfr.push({ key: f.company, len: f.data.length, hex: hexOf(f.data) });
      if (f.company === VICTRON_ID) {
        rec.victron = true;
        var tk = (f.data.length ? (f.data[0] < 16 ? '0' : '') + f.data[0].toString(16) : '--') + ' / ' + f.data.length + ' Byte';
        var tr = rec.types[tk] || (rec.types[tk] = { n: 0, hex: '' });
        tr.n += 1; tr.hex = hexOf(f.data);
        handleVictron(rec, f.data);
      }
    });
    if (rec.victron && !rec.ui) { updateTile(rec); }
    scheduleDiag();
  }

  var pendingDiag = false;
  function scheduleDiag() {
    if (pendingDiag) { return; }
    pendingDiag = true;
    setTimeout(function () { pendingDiag = false; renderDiag(); }, 1000);
  }

  function renderDiag() {
    var list = Object.keys(devices).map(function (k) { return devices[k]; });
    var shown = el('onlyVictron').checked ? list.filter(function (d) { return d.victron; }) : list;
    var box = el('devices');
    box.textContent = '';
    shown.forEach(function (d) {
      var card = document.createElement('div'); card.className = 'dev';
      var t = document.createElement('div');
      t.textContent = (d.name || '(ohne Namen)') + ' · ' + d.count + ' Meldungen';
      card.appendChild(t);
      Object.keys(d.types).sort().forEach(function (k) {
        var line = document.createElement('div'); line.className = 'hex';
        line.textContent = k + '  ·  ' + d.types[k].n + 'x  ·  ' + d.types[k].hex;
        card.appendChild(line);
      });
      box.appendChild(card);
    });
  }

  /* ---------- Gerät hinzufügen ---------- */
  function explain(err) {
    if (err && typeof err === 'object') { return (err.name || 'Fehler') + ': ' + (err.message || '') + (err.code !== undefined ? ' code=' + err.code : ''); }
    return 'Wert ' + typeof err + ': ' + String(err);
  }
  var watched = {};
  function loadKnown() {
    var v;
    try { v = JSON.parse(localStorage.getItem('victron-known') || '[]'); } catch (e) { return []; }
    if (!Array.isArray(v)) { return []; }
    return v.filter(function (d) { return d && typeof d.id === 'string' && d.id && (typeof d.name === 'string' || d.name === undefined); });
  }
  function isBms(name) { return /^(DP\d|SP\d|xiaoxiang|JBD|LZ)/i.test(name || ''); }
  var BMS_SVC = '0000ff00-0000-1000-8000-00805f9b34fb';
  var BMS_NOTIFY = '0000ff01-0000-1000-8000-00805f9b34fb';
  var BMS_WRITE = '0000ff02-0000-1000-8000-00805f9b34fb';
  var BMS_OPTS = [BMS_SVC];
  function startDevice(dev, how) { return isBms(dev.name) ? connectBms(dev, how) : watchDevice(dev, how); }

  /* Akku-Verbindung: aufräumen, damit nach einem Abbruch nichts doppelt läuft */
  function bmsTeardown(rec) {
    clearInterval(rec.poll); rec.poll = null;
    clearTimeout(rec.pollCells); rec.pollCells = null;
    if (rec.bmsChar && rec.bmsHandler) {
      try { rec.bmsChar.removeEventListener('characteristicvaluechanged', rec.bmsHandler); } catch (e) { /* egal */ }
    }
    rec.bmsChar = null; rec.bmsHandler = null;
  }
  function bmsErrorText(e) {
    var n = e && e.name;
    if (n === 'NotFoundError') { return 'Der Akku bietet den erwarteten Dienst (FF00) nicht an, oder der Browser darf ihn nicht nutzen. Wähle den Akku über „Verbinden“ neu aus.'; }
    if (n === 'SecurityError' || n === 'NotAllowedError') { return 'Der Browser erlaubt den Zugriff auf den Akku nicht. Wähle ihn über „Verbinden“ neu aus.'; }
    return 'Keine Verbindung zum Akku. Ist die LANGZEIT-App noch verbunden? Dann dort trennen. Die Seite versucht es automatisch weiter.';
  }
  /* Sicherheit: Das BMS kennt auch Schreibbefehle (z. B. Laden/Entladen abschalten).
     Diese Seite darf ausschließlich die beiden festen Lese-Anfragen senden, alles andere wird blockiert. */
  function isAllowedBmsRequest(arr) {
    var a = Array.prototype.join.call(arr, ',');
    return a === JBD_REQ_BASIC.join(',') || a === JBD_REQ_CELLS.join(',');
  }
  function bmsWrite(rec, tx, arr) {
    if (!isAllowedBmsRequest(arr)) { log('Blockiert: unerlaubte Anfrage an den Akku'); return; }
    var req = new Uint8Array(arr);
    function viaWithResponse() { return tx.writeValue ? tx.writeValue(req) : tx.writeValueWithResponse(req); }
    var p;
    try { p = tx.writeValueWithoutResponse ? tx.writeValueWithoutResponse(req) : viaWithResponse(); } catch (x) { p = Promise.reject(x); }
    Promise.resolve(p).catch(function (e1) {
      /* einmal mit der anderen Schreibart versuchen */
      var q;
      try { q = viaWithResponse(); } catch (x2) { q = Promise.reject(x2); }
      return Promise.resolve(q).catch(function (e2) {
        rec.writeErr = (rec.writeErr || 0) + 1;
        if (rec.writeErr <= 3) { log('Akku Anfrage: ' + explain(e1) + ' / ' + explain(e2)); }
      });
    });
  }

  function connectBms(dev, how) {
    rememberDevice(dev);
    var rec = devices[dev.id] || (devices[dev.id] = { id: dev.id, name: dev.name || '', rssi: null, count: 0, last: 0, mfr: [], victron: true, types: {} });
    rec.kind = 'bms';
    rec.dev = dev;
    rec.bmsWanted = true;
    watched[dev.id] = true;
    if (rec.bmsBusy) { return Promise.resolve(); }
    if (!dev.gatt) { rec.bmsMsg = 'Dieser Browser kann sich nicht mit dem Akku verbinden.'; updateTile(rec); return Promise.resolve(); }
    rec.bmsBusy = true;
    rec.bmsMsg = 'Verbinde mit dem Akku …';
    updateTile(rec);
    if (!rec.onDisc) {
      rec.onDisc = function () {
        /* verspätete Meldung einer alten Verbindung ignorieren */
        if (dev.gatt && dev.gatt.connected) { return; }
        bmsTeardown(rec);
        log('Akku getrennt: ' + (dev.name || dev.id));
        rec.bmsMsg = 'Verbindung zum Akku verloren, versuche es erneut …';
        updateTile(rec);
      };
      dev.addEventListener('gattserverdisconnected', rec.onDisc);
    }
    bmsTeardown(rec);
    var asm = new JbdAssembler();
    var tx;
    var rawLogged = 0, badLogged = 0, dumped = {};
    var pre = Promise.resolve();
    if (dev.gatt.connected) {
      /* hängende Verbindung sauber beenden, bevor neu aufgebaut wird */
      try { dev.gatt.disconnect(); } catch (e) { /* egal */ }
      pre = new Promise(function (res) { setTimeout(res, 500); });
    }
    return pre.then(function () {
      return dev.gatt.connect();
    }).then(function (server) {
      log('Akku: Verbindung steht, suche Dienst FF00');
      return server.getPrimaryService(BMS_SVC);
    }).then(function (svc) {
      return Promise.all([svc.getCharacteristic(BMS_NOTIFY), svc.getCharacteristic(BMS_WRITE)]);
    }).then(function (ch) {
      tx = ch[1];
      var handler = function (ev) {
        var v = ev.target.value;
        var bytes = Array.prototype.slice.call(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        if (rawLogged < 4) { rawLogged++; log('Akku Rohdaten (' + bytes.length + ' Byte): ' + hexOf(bytes)); }
        var badBefore = asm.bad;
        var frames;
        try { frames = asm.push(bytes); } catch (x) { log('Akku Auswertung: ' + explain(x)); return; }
        if (asm.bad !== badBefore && badLogged < 5) { badLogged++; log('Akku: ungültiger Rahmen verworfen (Summe ' + asm.bad + ')'); }
        frames.forEach(function (f) {
          if (f.status !== 0) { log('Akku meldet Fehlerstatus ' + f.status + ' bei Befehl ' + f.cmd); return; }
          if (!dumped[f.cmd]) { dumped[f.cmd] = true; log('Akku Befehl 0x' + f.cmd.toString(16) + ' (' + f.data.length + ' Byte): ' + hexOf(f.data)); }
          if (f.cmd === 0x03) {
            var bsc = decodeJbdBasic(f.data);
            if (bsc) { rec.jbdBasic = bsc; } else { log('Akku: Basisdaten zu kurz (' + f.data.length + ' Byte)'); }
          }
          if (f.cmd === 0x04) { rec.jbdCells = decodeJbdCells(f.data); }
          if (rec.jbdBasic) {
            rec.readout = jbdView(rec.jbdBasic, rec.jbdCells);
            rec.keyState = 'ok';
            rec.unsupported = null;
            rec.pktAt = Date.now();
            rec.bmsMsg = '';
            rec.bmsFail = 0;
            updateTile(rec);
          }
        });
      };
      rec.bmsChar = ch[0]; rec.bmsHandler = handler;
      ch[0].addEventListener('characteristicvaluechanged', handler);
      return ch[0].startNotifications();
    }).then(function () {
      log('Akku verbunden (' + how + '): ' + (dev.name || dev.id));
      rec.bmsMsg = 'Verbunden, warte auf Daten …';
      rec.bmsSince = Date.now();
      rec.writeErr = 0;
      updateTile(rec);
      var send = function () {
        bmsWrite(rec, tx, JBD_REQ_BASIC);
        clearTimeout(rec.pollCells);
        rec.pollCells = setTimeout(function () { bmsWrite(rec, tx, JBD_REQ_CELLS); }, 700);
      };
      clearInterval(rec.poll);
      send();
      rec.poll = setInterval(send, 2000);
      rec.bmsBusy = false;
    }).catch(function (e) {
      rec.bmsBusy = false;
      bmsTeardown(rec);
      rec.bmsFail = (rec.bmsFail || 0) + 1;
      log('Akku Verbindung (Versuch ' + rec.bmsFail + '): ' + explain(e));
      rec.bmsMsg = bmsErrorText(e);
      updateTile(rec);
    });
  }
  /* Wächter: baut die Akku-Verbindung neu auf, wenn sie weg ist oder nichts mehr ankommt */
  setInterval(function () {
    var now = Date.now();
    Object.keys(devices).forEach(function (k) {
      var rec = devices[k];
      if (rec.kind !== 'bms' || !rec.bmsWanted || rec.bmsBusy || !rec.dev) { return; }
      var connected = !!(rec.dev.gatt && rec.dev.gatt.connected);
      var since = rec.pktAt || rec.bmsSince || now;
      var silent = connected && !!rec.poll && (now - since) > 30000;
      if (connected && rec.poll && !rec.pktAt && (now - since) > 15000 && !/Antwort/.test(rec.bmsMsg || '')) {
        rec.bmsMsg = 'Verbunden, aber keine Antwort vom Akku. Ist die LANGZEIT-App noch geöffnet? Dann dort trennen.';
        updateTile(rec);
      }
      if ((!connected || silent) && now >= (rec.nextTry || 0)) {
        rec.nextTry = now + ((rec.bmsFail || 0) > 3 ? 30000 : 10000);
        log('Akku: neuer Verbindungsversuch' + (silent ? ' (seit 30 s keine Daten)' : ''));
        connectBms(rec.dev, 'erneut').catch(function () { /* steht im Protokoll */ });
      }
    });
  }, 5000);

  function updateKnownName(id, name) {
    var list = loadKnown();
    var changed = false;
    list.forEach(function (d) { if (d.id === id && d.name !== name) { d.name = name; changed = true; } });
    if (changed) { try { localStorage.setItem('victron-known', JSON.stringify(list)); } catch (e) { /* egal */ } }
  }
  function rememberDevice(dev) {
    var list = loadKnown().filter(function (d) { return d.id !== dev.id; });
    list.push({ id: dev.id, name: dev.name || '' });
    try { localStorage.setItem('victron-known', JSON.stringify(list)); } catch (e) { /* egal */ }
  }
  function watchDevice(dev, how) {
    if (typeof dev.watchAdvertisements !== 'function') { setStatus('Dieser Browser kann keine Meldungen beobachten.'); return Promise.resolve(); }
    if (!watched[dev.id]) { dev.addEventListener('advertisementreceived', onAdv); watched[dev.id] = true; }
    rememberDevice(dev);
    var rec = devices[dev.id] || (devices[dev.id] = { id: dev.id, name: dev.name || '', rssi: null, count: 0, last: 0, mfr: [], victron: true, types: {} });
    rec.connecting = false;
    updateTile(rec);
    return dev.watchAdvertisements().then(function () {
      log('Beobachtung läuft (' + how + '): ' + (dev.name || dev.id));
    });
  }
  function autoConnect() {
    var known = loadKnown();
    known.forEach(function (k) {
      if (!devices[k.id]) {
        devices[k.id] = { id: k.id, name: k.name, rssi: null, count: 0, last: 0, mfr: [], victron: true, types: {}, offline: true, kind: isBms(k.name) ? 'bms' : '' };
        updateTile(devices[k.id]);
      }
    });
    if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') {
      log('Automatisch verbinden: getDevices fehlt in diesem Browser');
      if (known.length) { setStatus('Tippe bei deinem Gerät auf „Verbinden“.'); }
      return;
    }
    navigator.bluetooth.getDevices().then(function (list) {
      log('Automatisch verbinden: ' + list.length + ' gemerkte Geräte vom Browser');
      if (!list.length && known.length) { setStatus('Der Browser hat sich kein Gerät gemerkt. Tippe bei deinem Gerät auf „Verbinden“.'); }
      list.forEach(function (dev) {
        startDevice(dev, 'automatisch').catch(function (e) { log('Automatisch fehlgeschlagen: ' + explain(e)); });
      });
    }).catch(function (e) { log('getDevices Fehler: ' + explain(e)); });
  }
  function reconnect(rec) {
    if (!navigator.bluetooth) { return; }
    var opts = rec.name ? { filters: [{ name: rec.name }], optionalServices: BMS_OPTS } : { acceptAllDevices: true, optionalServices: BMS_OPTS };
    log('Verbinden mit ' + (rec.name || rec.id));
    pickDevice(opts).then(function (dev) {
      if (dev.id !== rec.id && devices[rec.id] && devices[rec.id].ui && !devices[dev.id]) {
        /* Gerät hat neue Kennung: Kachel übernehmen */
        var keepName = own(loadNames(), rec.id);
        devices[dev.id] = devices[rec.id]; devices[dev.id].id = dev.id; delete devices[rec.id];
        if (keepName) { setCustomName(dev.id, keepName); }
      }
      return startDevice(dev, 'Verbinden');
    }).catch(function (e) {
      log('Verbinden fehlgeschlagen: ' + explain(e));
      setStatus('Verbinden hat nicht geklappt. Versuche „Gerät hinzufügen“.');
    });
  }

  /* requestDevice kann in manchen Browsern sofort werfen: als Fehler weiterreichen, damit er sichtbar wird */
  function pickDevice(opts) {
    try { return navigator.bluetooth.requestDevice(opts); } catch (e) { return Promise.reject(e); }
  }
  function addDevice() {
    if (!navigator.bluetooth) { setStatus('Dieser Browser hat kein Web Bluetooth. Öffne die Seite in Bluefy.'); return; }
    log('Geräteauswahl wird geöffnet');
    setStatus('Geräteauswahl wird geöffnet …');
    var timer = setTimeout(function () {
      log('Nach 8 s noch keine Rückmeldung der Geräteauswahl');
      setStatus('Falls keine Auswahl erscheint: Details stehen im Protokoll der Diagnose.');
    }, 8000);
    pickDevice({ acceptAllDevices: true, optionalServices: BMS_OPTS }).catch(function (e) {
      if (e && (e.name === 'TypeError' || e.name === 'SyntaxError')) {
        log('Auswahl mit Akku-Dienst abgelehnt (' + explain(e) + '), versuche ohne');
        return pickDevice({ acceptAllDevices: true });
      }
      throw e;
    }).then(function (dev) {
      clearTimeout(timer);
      log('Gewählt: ' + (dev.name || dev.id));
      return startDevice(dev, 'hinzugefügt').then(function () {
        setStatus('Beobachtung läuft für ' + (dev.name || dev.id) + '. Weitere Geräte kannst du jederzeit hinzufügen.');
      });
    }).catch(function (e) {
      clearTimeout(timer);
      setStatus('Das Gerät konnte nicht hinzugefügt werden: ' + explain(e));
      log('Fehler: ' + explain(e));
    });
  }

  /* ---------- Diagnose ---------- */
  function addCheck(label, level, value) {
    var li = document.createElement('li');
    var a = document.createElement('span'); a.textContent = label;
    var b = document.createElement('span'); b.className = 'pill ' + level; b.textContent = value;
    li.appendChild(a); li.appendChild(b);
    el('checks').appendChild(li);
  }
  function systemCheck() {
    addCheck('Sichere Verbindung (https)', window.isSecureContext ? 'ok' : 'bad', window.isSecureContext ? 'ja' : 'nein');
    addCheck('Web Bluetooth', navigator.bluetooth ? 'ok' : 'bad', navigator.bluetooth ? 'ja' : 'nein');
    addCheck('Entschlüsselung (WebCrypto)', subtle ? 'ok' : 'bad', subtle ? 'ja' : 'nein');
    var ok = false;
    try { ok = !!localStorage; } catch (e) { ok = false; }
    addCheck('Schlüssel speichern', ok ? 'ok' : 'warn', ok ? 'ja' : 'nein');
    var gd = !!(navigator.bluetooth && typeof navigator.bluetooth.getDevices === 'function');
    addCheck('Automatisch verbinden (getDevices)', gd ? 'ok' : 'warn', gd ? 'ja' : 'nein');
  }
  function copyLog() {
    var text = logLines.join('\n');
    var ta = el('log');
    function fallback() { ta.focus(); ta.select(); setStatus('Text markiert. Jetzt kopieren.'); }
    try { navigator.clipboard.writeText(text).then(function () { setStatus('Protokoll kopiert.'); }, fallback); } catch (e) { fallback(); }
  }

  /* ---------- Anordnen ---------- */
  function tileList() { return Array.prototype.slice.call(el('tiles').querySelectorAll('.tile')); }
  function loadOrder() {
    var v;
    try { v = JSON.parse(localStorage.getItem('victron-order') || '[]'); } catch (e) { return []; }
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : [];
  }
  function saveOrder() {
    var ids = tileList().map(function (t) { return t.dataset.id; });
    try { localStorage.setItem('victron-order', JSON.stringify(ids)); } catch (e) { /* egal */ }
  }
  function applyOrder() {
    var order = loadOrder();
    var box = el('tiles');
    tileList().map(function (t) {
      var i = order.indexOf(t.dataset.id);
      return { t: t, i: i < 0 ? 999 : i };
    }).sort(function (a, b) { return a.i - b.i; }).forEach(function (x) { box.appendChild(x.t); });
  }
  function moveTile(tile, delta) {
    var list = tileList();
    var i = list.indexOf(tile);
    var j = i + delta;
    if (j < 0 || j >= list.length) { return; }
    var box = el('tiles');
    if (delta < 0) { box.insertBefore(tile, list[j]); } else { box.insertBefore(tile, list[j].nextSibling); }
    saveOrder();
  }
  function startDrag(handle, tile) {
    function move(e) {
      var under = document.elementFromPoint(e.clientX, e.clientY);
      var target = under && under.closest ? under.closest('.tile') : null;
      if (!target || target === tile) { return; }
      var list = tileList();
      var box = el('tiles');
      if (list.indexOf(target) < list.indexOf(tile)) { box.insertBefore(tile, target); }
      else { box.insertBefore(tile, target.nextSibling); }
    }
    function end() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      tile.classList.remove('dragging');
      saveOrder();
    }
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      tile.classList.add('dragging');
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });
  }
  el('btnArrange').addEventListener('click', function () {
    var on = !document.body.classList.contains('arranging');
    document.body.classList.toggle('arranging', on);
    this.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.textContent = on ? 'Fertig' : 'Anordnen';
    if (!on) { saveOrder(); }
  });

  function layout() {
    var t = el('tiles');
    var n = t.querySelectorAll('.tile').length;
    if (window.innerWidth < 600 || !n) { t.style.height = ''; t.style.gridTemplateRows = ''; return; }
    var rows = Math.ceil(n / 2);
    var top = t.getBoundingClientRect().top + (window.pageYOffset || 0);
    var h = window.innerHeight - top - 10;
    t.style.height = Math.max(h, rows * 200) + 'px';
    t.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    t.classList.toggle('dense', rows >= 3);
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', function () { setTimeout(layout, 300); });

  /* Hell/Dunkel: ohne eigene Wahl folgt die Seite dem iPad, ein Tipp wechselt und merkt sich die Wahl */
  function systemDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; }
  }
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || (systemDark() ? 'dark' : 'light'); }
  function showThemeButton() {
    var dark = currentTheme() === 'dark';
    var b = el('btnTheme');
    b.textContent = dark ? '☀ Hell' : '☾ Dunkel';
    b.setAttribute('aria-label', dark ? 'Zum hellen Modus wechseln' : 'Zum dunklen Modus wechseln');
  }
  el('btnTheme').addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('victron-theme', next); } catch (e) { /* egal */ }
    showThemeButton();
  });
  showThemeButton();

  el('btnAdd').addEventListener('click', addDevice);
  el('btnCopy').addEventListener('click', copyLog);
  el('onlyVictron').addEventListener('change', renderDiag);
  setInterval(function () {
    Object.keys(devices).forEach(function (k) { if (devices[k].ui) { updateTile(devices[k]); } });
  }, 1000);

  systemCheck();
  log('Seite geladen');
  autoConnect();
})();
