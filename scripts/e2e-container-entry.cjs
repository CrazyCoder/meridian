// Runs only inside the disposable integration image; retain lifecycle fencing.
const fs = require('node:fs')
const crypto = require('node:crypto')
const {spawnSync} = require('node:child_process')
if (process.platform !== 'linux' || process.env.E2E_CONTAINER !== '1') throw Error('Use the disposable E2E container')
let identity = ''
try { identity = fs.readFileSync('/etc/machine-id', 'utf8').trim() } catch (error) { if (error.code !== 'ENOENT') throw error }
if (!identity) fs.writeFileSync('/etc/machine-id', crypto.randomBytes(16).toString('hex')+'\n')
const result = spawnSync(process.argv[2], process.argv.slice(3), {stdio:'inherit',env:process.env})
if(result.error) throw result.error
process.exit(result.status ?? 1)
