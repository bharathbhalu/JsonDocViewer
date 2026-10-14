// HTTPS certificates for Accretion's built-in HTTPS mode.
// A small local certificate authority (CA) is created once in
// ~/.accretion/tls/; it signs a server certificate for localhost, this
// computer's names and its current LAN addresses. Other devices install the
// CA certificate once (ca.crt) and then trust Accretion without warnings.
// The server certificate is re-issued automatically when the names or
// addresses change or it is close to expiring.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function setupTls(configDir) {
  const dir = path.join(configDir, 'tls');
  const file = (n) => path.join(dir, n);
  const SERVER_DAYS = 397; // browsers reject longer-lived leaf certificates

  function openssl(args, input) {
    return execFileSync('openssl', args, { cwd: dir, input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }).toString();
  }

  function names() {
    const host = os.hostname().replace(/\.local$/i, '');
    let local = '';
    try { if (process.platform === 'darwin') local = execFileSync('scutil', ['--get', 'LocalHostName'], { timeout: 3000 }).toString().trim(); } catch (e) { /* none */ }
    const dns = [...new Set(['localhost', host, host + '.local', local && local + '.local'].filter(Boolean).map((s) => s.toLowerCase()))];
    const ips = ['127.0.0.1', '::1'];
    Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((a) => { if (!a.internal && a.family === 'IPv4') ips.push(a.address); }));
    return { dns, ips: [...new Set(ips)] };
  }

  function ensureCa() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file('ca.key')) && fs.existsSync(file('ca.crt'))) return;
    const cn = 'Accretion local CA (' + os.hostname().replace(/\.local$/i, '') + ')';
    fs.writeFileSync(file('ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'x509_extensions=v3_ca', 'prompt=no',
      '[dn]', 'CN=' + cn, 'O=Accretion',
      '[v3_ca]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
    ].join('\n'));
    openssl(['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-sha256', '-config', 'ca.cnf']);
    fs.chmodSync(file('ca.key'), 0o600);
  }

  function serverIsCurrent(want) {
    try {
      const meta = JSON.parse(fs.readFileSync(file('server.json'), 'utf8'));
      const sameNames = JSON.stringify(meta.names) === JSON.stringify(want);
      const fresh = Date.now() < meta.expires - 30 * 864e5;
      return sameNames && fresh && fs.existsSync(file('server.key')) && fs.existsSync(file('server.crt'));
    } catch (e) {
      return false;
    }
  }

  // Make sure a valid server certificate exists. Returns { key, cert, ... }.
  function ensure() {
    ensureCa();
    const want = names();
    if (!serverIsCurrent(want)) {
      const san = want.dns.map((d, i) => `DNS.${i + 1} = ${d}`).concat(want.ips.map((ip, i) => `IP.${i + 1} = ${ip}`));
      fs.writeFileSync(file('server.cnf'), [
        '[req]', 'distinguished_name=dn', 'req_extensions=v3', 'prompt=no',
        '[dn]', 'CN=' + want.dns[1], 'O=Accretion',
        '[v3]', 'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', 'subjectAltName=@alt',
        '[alt]', ...san,
      ].join('\n'));
      openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-config', 'server.cnf']);
      openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', String(SERVER_DAYS), '-sha256', '-extfile', 'server.cnf', '-extensions', 'v3']);
      fs.chmodSync(file('server.key'), 0o600);
      fs.writeFileSync(file('server.json'), JSON.stringify({ names: want, issued: Date.now(), expires: Date.now() + SERVER_DAYS * 864e5 }));
      try { fs.unlinkSync(file('server.csr')); } catch (e) { /* ignore */ }
      console.log('HTTPS: issued a certificate for ' + want.dns.concat(want.ips).join(', '));
    }
    const meta = JSON.parse(fs.readFileSync(file('server.json'), 'utf8'));
    return { key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.crt')), names: meta.names, expires: meta.expires };
  }

  function caPem() { ensureCa(); return fs.readFileSync(file('ca.crt')); }
  function caFingerprint() {
    try { return openssl(['x509', '-in', 'ca.crt', '-noout', '-fingerprint', '-sha256']).split('=')[1].trim(); } catch (e) { return ''; }
  }
  // Is the CA trusted by this Mac's keychain?
  function trustedOnThisMac() {
    if (process.platform !== 'darwin') return null;
    try { execFileSync('security', ['verify-cert', '-c', file('server.crt'), '-p', 'ssl'], { stdio: 'ignore', timeout: 5000 }); return true; } catch (e) { return false; }
  }

  return { dir, ensure, names, caPem, caFingerprint, trustedOnThisMac, caPath: file('ca.crt') };
};
