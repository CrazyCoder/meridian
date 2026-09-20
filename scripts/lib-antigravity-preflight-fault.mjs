// Opt-in live fault: withhold the first official /config result until its deadline.
// No configuration contents are retained. All later commands use the real CLI.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export async function preflightFault(root, official, kind = 'config') {
  if (!['config', 'models'].includes(kind)) throw new Error('Unsupported read-only probe fault')
  const executable = join(root, 'agy-preflight-fault.cjs')
  const audit = join(root, 'preflight-audit.jsonl')
  const marker = join(root, 'preflight-stalled')
  await writeFile(audit, '')
  await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'), {spawn,spawnSync}=require('node:child_process');
const args=process.argv.slice(2), audit=${JSON.stringify(audit)}, marker=${JSON.stringify(marker)};
const log=value=>fs.appendFileSync(audit,JSON.stringify({...value,pid:process.pid,time:Date.now()})+'\\n');
if(${kind === 'models' ? "args[0]==='models'" : "args[0]==='-p'&&args[1]==='/config'"}) {
 const first=!fs.existsSync(marker);
 if(first) {fs.writeFileSync(marker,'claimed');log({event:'${kind}-stall-start'});}
 const result=spawnSync(${JSON.stringify(official)},args,{encoding:'utf8',maxBuffer:1024*1024});
 if(first&&result.status===0) {log({event:'${kind}-stalled'});setInterval(()=>{},1000);}
 else {log({event:'${kind}-forwarded',code:result.status});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status??1;}
} else {
 if(args.includes('--input-format')) log({event:'model-start'});
 const child=spawn(${JSON.stringify(official)},args,{stdio:'inherit'});
 child.once('error',()=>{process.exitCode=1});
 child.once('exit',(code)=>{process.exitCode=code??1});
}
`, { mode: 0o755 })
  return { executable, audit, kind }
}
