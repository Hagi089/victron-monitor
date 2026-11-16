/* Simuliertes Web Bluetooth für Screenshots (6 Geräte, Testschlüssel). Szenario über localStorage mock-scen: normal | low (Warnwerte, Zell-Alarm) */
(function () {
  var SCEN = localStorage.getItem('mock-scen') || 'normal';
  var low = SCEN === 'low';
  var KEY = '0123456789abcdef0123456789abcdef';
  var DEVS = [
    { id: 'agm', name: 'Obelix AGM 200ah', label: 'Obelix AGM 200ah', type: 2, rssi: -62 },
    { id: 'lith', name: 'DP04S007L4S100A', label: 'Obelix Lithium 200ah', bms: true },
    { id: 's1', name: 'Obelix Solar 100/20', label: 'Obelix Solar 100/20', type: 1, rssi: -58, state: 3, v: 13.29, i: 2.7, y: 840, pv: 38 },
    { id: 's2', name: 'Obelix Solar 75/15', label: 'Obelix Solar 75/15', type: 1, rssi: -66, state: 5, v: 13.31, i: 0.4, y: 410, pv: 6 },
    { id: 'chg', name: 'Obelix 12/25 HQ260', label: 'Obelix 12/25 HQ260', type: 8, rssi: -74 },
    { id: 'sem', name: 'Voltcraft', label: 'Obelix 230 Volt (außen)', sem: true }
  ];
  if (!localStorage.getItem('victron-known')) {
    var keys = {}, names = {};
    DEVS.forEach(function (d) { if (d.type) { keys[d.name] = KEY; } names[d.id] = d.label; });
    localStorage.setItem('victron-keys', JSON.stringify(keys));
    localStorage.setItem('victron-names', JSON.stringify(names));
    localStorage.setItem('victron-known', JSON.stringify(DEVS.map(function (d) { return { id: d.id, name: d.name }; })));
    localStorage.setItem('victron-pins', JSON.stringify({ sem: '1234' }));
  }
  function setBits(b, off, n, val) {
    for (var k = 0; k < n; k++) {
      var bit = Math.floor(val / Math.pow(2, k)) % 2;
      var p = off + k;
      if (bit) { b[p >> 3] |= (1 << (p & 7)); }
    }
  }
  function tw(v, n) { return v < 0 ? Math.pow(2, n) + v : v; }
  function plain(d) {
    var b;
    if (d.type === 1) {
      b = new Uint8Array(12);
      setBits(b, 0, 8, d.state); setBits(b, 16, 16, tw(Math.round(d.v * 100), 16)); setBits(b, 32, 16, tw(Math.round(d.i * 10), 16));
      setBits(b, 48, 16, d.y / 10); setBits(b, 64, 16, d.pv); setBits(b, 80, 9, 0x1FF);
    } else if (d.type === 2) {
      b = new Uint8Array(15);
      var soc = low ? 62.0 : 86.4;
      setBits(b, 16, 16, Math.round((low ? 12.21 : 12.71) * 100)); setBits(b, 48, 16, 0xFFFF); setBits(b, 64, 2, 3);
      setBits(b, 66, 22, tw(Math.round((low ? -6.8 : -3.42) * 1000), 22)); setBits(b, 88, 20, Math.round((100 - soc) * 2 * 10)); setBits(b, 108, 10, Math.round(soc * 10));
    } else {
      b = new Uint8Array(13);
      setBits(b, 0, 8, 0); setBits(b, 16, 13, 1271); setBits(b, 29, 11, 0);
      setBits(b, 40, 13, 0x1FFF); setBits(b, 53, 11, 0x7FF); setBits(b, 64, 13, 0x1FFF); setBits(b, 77, 11, 0x7FF);
      setBits(b, 88, 7, 56); setBits(b, 95, 9, 0x1FF);
    }
    return b;
  }
  var ckP = crypto.subtle.importKey('raw', new Uint8Array(KEY.match(/../g).map(function (h) { return parseInt(h, 16); })), { name: 'AES-CBC' }, false, ['encrypt']);
  function cb(iv, i) { var c = new Uint8Array(16); c[0] = iv & 255; c[1] = iv >> 8; var carry = i; for (var j = 15; j >= 0 && carry; j--) { var s = c[j] + carry; c[j] = s & 255; carry = s >> 8; } return c; }
  function adv(d) {
    var p = plain(d), iv = Math.floor(Math.random() * 65535);
    return ckP.then(function (ck) {
      var jobs = []; for (var i = 0; i < Math.ceil(p.length / 16); i++) { jobs.push(crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, ck, cb(iv, i))); }
      return Promise.all(jobs);
    }).then(function (res) {
      var out = new Uint8Array(8 + p.length);
      out[0] = 0x10; out[2] = 0xA0; out[3] = 0xA0; out[4] = d.type; out[5] = iv & 255; out[6] = iv >> 8; out[7] = 0x01;
      for (var k = 0; k < p.length; k++) { out[8 + k] = p[k] ^ new Uint8Array(res[k >> 4])[k & 15]; }
      return out;
    });
  }
  function Target() { this.l = {}; }
  Target.prototype.addEventListener = function (t, f) { (this.l[t] = this.l[t] || []).push(f); };
  Target.prototype.removeEventListener = function () {};
  Target.prototype.emit = function (t, ev) { (this.l[t] || []).forEach(function (f) { f(ev); }); };
  function jbd(cmd, data) {
    var f = [0xDD, cmd, 0, data.length].concat(data), sum = 0;
    for (var i = 2; i < f.length; i++) { sum += f[i]; }
    var c = (0x10000 - sum) & 0xFFFF; return f.concat([c >> 8, c & 255, 0x77]);
  }
  function u16(v) { v = v < 0 ? 0x10000 + v : v; return [v >> 8, v & 255]; }
  function semF(body) { var s = 1; body.forEach(function (x) { s += x; }); return [0x0F, body.length + 1].concat(body, [s & 255, 0xFF, 0xFF]); }
  function mkDev(d) {
    var dev = new Target();
    dev.id = d.id; dev.name = d.name;
    if (d.type) {
      dev.watchAdvertisements = function () {
        function tick() { adv(d).then(function (b) { var m = new Map(); m.set(0x02E1, new DataView(b.buffer)); dev.emit('advertisementreceived', { device: dev, name: d.name, rssi: d.rssi, manufacturerData: m }); }); }
        tick(); setInterval(tick, 1000); return Promise.resolve();
      };
    } else {
      var notify = new Target(), write = {};
      notify.startNotifications = function () { return Promise.resolve(); };
      function send(arr) { setTimeout(function () { var u = new Uint8Array(arr); notify.value = new DataView(u.buffer); notify.emit('characteristicvaluechanged', { target: notify }); }, 30); }
      write.writeValueWithoutResponse = function (req) {
        var a = Array.prototype.slice.call(req);
        if (d.bms) {
          var soc = low ? 12 : 78, i = low ? -1250 : 185;
          if (a[2] === 3) { send(jbd(3, [].concat(u16(low ? 1268 : 1328), u16(i), u16(soc * 200), u16(20000), u16(23), [0, 0, 0, 0, 0, 0], [0, 0], [0], [soc, 3, 4, 2], u16(2876), u16(2871)))); }
          else { var c = low ? [2985, 3104, 3101, 3110] : [3318, 3324, 3321, 3320]; send(jbd(4, [].concat(u16(c[0]), u16(c[1]), u16(c[2]), u16(c[3])))); }
        } else {
          if (a[2] === 0x17) { send(semF([0x17, 0x00, 0x00])); }
          else if (a[2] === 0x04) { var mw = 412000, ma = 1860; send(semF([0x04, 0x00, 1, (mw >> 16) & 255, (mw >> 8) & 255, mw & 255, 231, ma >> 8, ma & 255, 50, 0, 0, 0, 0, 0x96, 0xD1])); }
          else if (a[2] === 0x0A) { var h = []; for (var k = 0; k < 24; k++) { h.push(0, k > 23 - new Date().getHours() - 1 ? 70 : 0); } send(semF([0x0A, 0x00].concat(h))); }
        }
        return Promise.resolve();
      };
      var svc = { getCharacteristic: function (u) { return Promise.resolve(/ff01|fff4/.test(u) ? notify : write); } };
      dev.gatt = { connected: false, connect: function () { this.connected = true; var g = this; return Promise.resolve({ getPrimaryService: function () { return Promise.resolve(svc); } }); }, disconnect: function () { this.connected = false; } };
    }
    return dev;
  }
  var list = DEVS.map(mkDev);
  Object.defineProperty(navigator, 'bluetooth', { value: { getDevices: function () { return Promise.resolve(list); }, requestDevice: function () { return Promise.reject(new Error('mock')); } } });
})();
