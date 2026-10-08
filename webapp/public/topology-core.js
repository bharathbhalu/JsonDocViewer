// Build a network topology flow board from NVUE cache JSON files
// (`*-vxpd-nvue-cache.json`): one box per switch / server, one line per
// connected pair (labelled with link count and speed), rows by role
// (spine / leaf / server …) in frames, and per-port wiring in each box's note.
// Pure: takes parsed JSON documents and FlowCore, returns flow data.
(function (global) {
  // Row order top to bottom; out-of-band last so its few lines don't cross
  // the leaf-to-server links.
  const ROLE_ORDER = ['border', 'spine', 'leaf', 'server', 'oob'];
  const ROLE_TITLE = { border: 'Border', spine: 'Spines', leaf: 'Leaves', oob: 'Out-of-band', server: 'Servers' };
  const ROLE_STYLE = {
    border: { fill: '#FCE4EC', border: '#AD1457' },
    spine: { fill: '#D7E3FC', border: '#3F63A8' },
    leaf: { fill: '#DDF4E4', border: '#3E8E5E' },
    oob: { fill: '#EDE7F6', border: '#7E57C2' },
    server: { fill: '#FFF1D6', border: '#B7791F' },
  };
  const BOX_W = 210;
  const BOX_H = 84;
  const GAP_X = 40;
  const ROW_GAP = 190;

  function isNvueCache(d) {
    return !!(d && typeof d === 'object' && d.sw && d.ports && typeof d.ports === 'object');
  }

  function roleFromName(name) {
    const n = String(name || '').toLowerCase();
    if (/spine/.test(n)) return 'spine';
    if (/oob|mgmt/.test(n)) return 'oob';
    if (/border|exit|edge|gw/.test(n)) return 'border';
    if (/leaf|tor/.test(n)) return 'leaf';
    return 'server';
  }
  function normRole(r, name) {
    const v = String(r || '').toLowerCase();
    if (ROLE_ORDER.includes(v)) return v;
    if (v === 'switch' || !v) return roleFromName(name);
    return roleFromName(name);
  }

  // Natural sort: leaf-r2 before leaf-r10.
  function natCmp(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // Gather nodes and links from all documents.
  function collect(docs) {
    const nodes = new Map(); // name -> { name, role, asn, lo, mgmt, desc, ports: [] }
    const node = (name) => {
      if (!nodes.has(name)) nodes.set(name, { name, role: null, asn: '', lo: '', mgmt: '', desc: '', ports: [], fromFile: false });
      return nodes.get(name);
    };
    const linkMap = new Map(); // "a|b" sorted -> { a, b, pairs: Map(key -> pair) }
    docs.filter(isNvueCache).forEach((d) => {
      const sw = d.sw;
      const me = node(sw.Location || sw.Name || ('switch-' + sw.ID));
      me.fromFile = true;
      me.role = normRole(sw.Role || sw.Type, me.name);
      me.asn = sw.ASN || me.asn;
      me.lo = sw.IPAddr || me.lo;
      me.mgmt = sw.MngIPAddr || me.mgmt;
      me.desc = sw.Description || me.desc;
      (Array.isArray(d['hw-link-connection-graph']) ? d['hw-link-connection-graph'] : []).forEach((g) => {
        if (!g || !g.Name) return;
        const n = node(g.Name);
        if (!n.asn && g.Asn) n.asn = g.Asn;
        if (!n.lo && g.Lo) n.lo = g.Lo;
        if (!n.role) n.role = roleFromName(g.Name);
      });
      Object.values(d.ports).forEach((p) => {
        const lp = (p && p.LinkProps) || {};
        const remote = lp.RemoteSwitchName;
        if (!remote) return;
        const other = node(remote);
        if (!other.role) other.role = roleFromName(remote);
        const pair = {
          a: me.name, aPort: p.Name || p.IfaceName || '', b: remote, bPort: lp.RemotePortName || lp.RemotePortIfaceName || '',
          speed: p.Speed || p.DesiredSpeed || '', oper: String(p.OperStatus || ''), aIp: lp.LocalIPv4Cidr || '', bIp: lp.RemoteIPv4Cidr || '',
        };
        me.ports.push(pair);
        const [x, y] = [me.name, remote].sort(natCmp);
        const key = x + '|' + y;
        if (!linkMap.has(key)) linkMap.set(key, { a: x, b: y, pairs: new Map() });
        // The same cable is seen from both ends: key the pair by both ports.
        const ends = [me.name + ':' + pair.aPort, remote + ':' + pair.bPort].sort().join('~');
        const L = linkMap.get(key);
        const prev = L.pairs.get(ends);
        if (!prev || (/up/i.test(pair.oper) && !/up/i.test(prev.oper))) L.pairs.set(ends, pair);
      });
    });
    nodes.forEach((n) => { if (!n.role) n.role = roleFromName(n.name); });
    return { nodes, links: [...linkMap.values()] };
  }

  // opts.servers: 'individual' | 'grouped' | 'hidden'
  function build(docs, C, opts) {
    const o = Object.assign({ servers: 'auto', title: 'Network topology' }, opts || {});
    const { nodes, links } = collect(docs);
    if (!nodes.size) throw new Error('No NVUE cache data found (expected *-vxpd-nvue-cache.json files).');
    let serverMode = o.servers;
    const servers = [...nodes.values()].filter((n) => n.role === 'server');
    if (serverMode === 'auto') serverMode = servers.length > 24 ? 'grouped' : 'individual';

    // Servers grouped by the set of switches they connect to.
    const groups = new Map();
    if (serverMode !== 'individual') {
      servers.forEach((srv) => {
        const peers = links.filter((l) => l.a === srv.name || l.b === srv.name).map((l) => (l.a === srv.name ? l.b : l.a)).sort(natCmp);
        const key = peers.join(',') || '(unconnected)';
        if (!groups.has(key)) groups.set(key, { key, peers, members: [] });
        groups.get(key).members.push(srv);
      });
      servers.forEach((srv) => nodes.delete(srv.name));
      if (serverMode === 'grouped') {
        groups.forEach((g, key) => {
          g.members.sort((a, b) => natCmp(a.name, b.name));
          const first = g.members[0].name;
          const last = g.members[g.members.length - 1].name;
          const name = 'servers:' + key;
          nodes.set(name, {
            name, role: 'server', group: g, asn: '', lo: '', mgmt: '', desc: '', ports: [], fromFile: false,
            label: g.members.length + ' server' + (g.members.length === 1 ? '' : 's') + '\n' + (g.members.length > 1 ? first + ' … ' + last : first),
          });
        });
      }
    }

    // Rows by role, ordered by name; servers ordered under their first switch.
    const rows = ROLE_ORDER.map((role) => [...nodes.values()].filter((n) => n.role === role));
    // Order rows to untangle lines: the first row by name, every later row
    // by the average position of what it connects to above (barycenter),
    // so separate fabrics (e.g. N-S and E-W) end up side by side.
    const peersOf = (n) => (n.group ? n.group.peers : links.filter((l) => l.a === n.name || l.b === n.name).map((l) => (l.a === n.name ? l.b : l.a)));
    const pos = new Map(); // name -> relative x (0..1) in its row
    let placedAny = false;
    rows.forEach((row) => {
      if (!row.length) return;
      if (!placedAny) {
        row.sort((a, b) => natCmp(a.name, b.name));
        placedAny = true;
      } else {
        const center = (n) => {
          const xs = peersOf(n).map((p) => pos.get(p)).filter((x) => x != null);
          return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 2; // unconnected go last
        };
        const c = new Map(row.map((n) => [n.name, center(n)]));
        row.sort((a, b) => (c.get(a.name) - c.get(b.name)) || natCmp(a.name, b.name));
      }
      row.forEach((n, i) => pos.set(n.name, row.length > 1 ? i / (row.length - 1) : 0.5));
    });
    // The first row is now re-ordered by its own lower neighbours, so the
    // top row follows the fabric grouping too.
    const firstRow = rows.find((r) => r.length);
    if (firstRow && firstRow.length > 1) {
      const below = (n) => {
        const xs = peersOf(n).map((p) => pos.get(p)).filter((x, i, arr) => x != null);
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 2;
      };
      const c = new Map(firstRow.map((n) => [n.name, below(n)]));
      firstRow.sort((a, b) => (c.get(a.name) - c.get(b.name)) || natCmp(a.name, b.name));
    }

    const data = C.createEmpty();
    const shapeOf = new Map();
    const usedRows = rows.map((row, ri) => ({ role: ROLE_ORDER[ri], row })).filter((r) => r.row.length);
    const widest = Math.max(...usedRows.map((r) => r.row.length * (BOX_W + GAP_X) - GAP_X));
    usedRows.forEach(({ role, row }, ri) => {
      const rowW = row.length * (BOX_W + GAP_X) - GAP_X;
      const x0 = 80 + (widest - rowW) / 2;
      const y = 120 + ri * ROW_GAP;
      const frame = C.defaultFrame(x0 - 30, y - 30, rowW + 60, BOX_H + 60);
      frame.title = ROLE_TITLE[role] + ' (' + row.length + ')';
      data.frames.push(frame);
      row.forEach((n, i) => {
        const s = C.defaultShape('process', x0 + i * (BOX_W + GAP_X), y);
        s.w = BOX_W;
        s.h = BOX_H;
        s.x = x0 + i * (BOX_W + GAP_X);
        s.y = y;
        s.frameId = frame.id;
        s.style.fill = ROLE_STYLE[role].fill;
        s.style.border = ROLE_STYLE[role].border;
        s.format = Object.assign(s.format || {}, { fontSize: 13 });
        s.text = n.label || [n.name, n.asn ? 'AS ' + n.asn : '', n.lo ? 'lo ' + n.lo : ''].filter(Boolean).join('\n');
        const noteLines = [];
        if (n.desc) noteLines.push(n.desc);
        if (n.mgmt) noteLines.push('mgmt ' + n.mgmt);
        if (n.group) noteLines.push('Servers: ' + n.group.members.map((m) => m.name).join(', '));
        if (n.ports.length) {
          noteLines.push('Ports:');
          n.ports.slice().sort((p, q) => natCmp(p.aPort, q.aPort)).forEach((p) => {
            noteLines.push(`${p.aPort} → ${p.b} ${p.bPort}${p.speed ? ' · ' + p.speed : ''}${p.oper ? ' · ' + p.oper : ''}${p.aIp ? ' · ' + p.aIp : ''}`);
          });
        }
        s.note = noteLines.join('\n').slice(0, 20000);
        data.shapes[s.id] = s;
        shapeOf.set(n.name, s);
      });
    });

    // Lines: map server members to their group box when grouped.
    const boxName = (name) => {
      if (shapeOf.has(name)) return name;
      for (const g of groups.values()) if (g.members.some((m) => m.name === name)) return 'servers:' + g.key;
      return null;
    };
    const merged = new Map();
    links.forEach((l) => {
      const a = boxName(l.a);
      const b = boxName(l.b);
      if (!a || !b || a === b) return;
      const key = [a, b].sort(natCmp).join('|');
      if (!merged.has(key)) merged.set(key, { a, b, pairs: [] });
      merged.get(key).pairs.push(...l.pairs.values());
    });
    const rank = (name) => ROLE_ORDER.indexOf((nodes.get(name) || {}).role || 'server');
    merged.forEach((m) => {
      // Lines run from the upper row down.
      const [top, bottom] = rank(m.a) <= rank(m.b) ? [m.a, m.b] : [m.b, m.a];
      const sTop = shapeOf.get(top);
      const sBot = shapeOf.get(bottom);
      if (!sTop || !sBot) return;
      const sameRow = rank(top) === rank(bottom);
      const c = C.defaultConnector(
        { shapeId: sTop.id, port: sameRow ? (sTop.x < sBot.x ? 'e' : 'w') : 's' },
        { shapeId: sBot.id, port: sameRow ? (sTop.x < sBot.x ? 'w' : 'e') : 'n' },
      );
      const up = m.pairs.filter((p) => /up/i.test(p.oper)).length;
      const speeds = [...new Set(m.pairs.map((p) => p.speed).filter(Boolean))];
      c.label = (m.pairs.length > 1 ? '×' + m.pairs.length : (m.pairs[0] ? m.pairs[0].aPort + ' ↔ ' + m.pairs[0].bPort : ''))
        + (speeds.length ? ' · ' + speeds.join('/') : '');
      c.style.arrow = 'none';
      c.style.route = 'straight';
      c.style.width = Math.min(6, 1.5 + Math.log2(Math.max(1, m.pairs.length)) * 0.6);
      c.style.color = up ? '#3E8E5E' : '#9AA3B2';
      if (!up) c.style.dash = 'dashed';
      data.connectors[c.id] = c;
    });

    data.viewport = { x: 40, y: 40, zoom: Math.max(0.2, Math.min(0.85, 1400 / (widest + 200))) };
    return { data, stats: { switches: [...nodes.values()].filter((n) => n.role !== 'server').length, servers: servers.length, links: Object.keys(data.connectors).length, serverMode } };
  }

  const api = { isNvueCache, collect, build };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.TopologyCore = api;
})(typeof window !== 'undefined' ? window : this);
