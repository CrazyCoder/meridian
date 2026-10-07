import {writeFileSync} from 'node:fs'
// A real stdio MCP server advertises unused tools; the client owns its tool list.
export function writeUnusedToolRoster(path) {
 writeFileSync(path, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'unused-roster',version:'1'}}:m.method==='tools/list'?{tools:Array.from({length:80},(_,i)=>({name:'unused_'+i,description:'Unused synthetic tool',inputSchema:{type:'object',properties:{}}}))}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`)
}
