const vscode=require('vscode'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
function activate(context){
  let panel=null,lastSequence=0,checking=false,panelReady=false,selectedConversation=null;
  const stateDir=()=>vscode.workspace.getConfiguration('codexBridge').get('stateDir')||path.join(os.homedir(),'.antigravity-codex');
  async function runtime(){
    const r=JSON.parse(await fs.readFile(path.join(stateDir(),'runtime.json'),'utf8'));
    const u=new URL(r.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||!/^[a-f0-9]{64}$/.test(r.token))throw new Error('Invalid bridge runtime file');return r;
  }
  async function call(name,args={}){
    const r=await runtime(),res=await fetch(r.url+'/api/tool',{method:'POST',headers:{Authorization:`Bearer ${r.token}`,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args}),signal:AbortSignal.timeout(90000)});
    const result=await res.json();if(!res.ok)throw new Error(result.error||'Bridge request failed');return result;
  }
  async function open(conversation_id){
    if(!vscode.workspace.isTrusted)throw new Error('Open the Codex panel only in a trusted workspace.');
    if(conversation_id)selectedConversation=conversation_id;
    if(!panel){
      panelReady=false;
      const created=vscode.window.createWebviewPanel('codexBridge','Codex Conversations',vscode.ViewColumn.Beside,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[]});
      panel=created;
      const nonce=crypto.randomBytes(20).toString('hex');
      let html=await fs.readFile(path.join(context.extensionPath,'ui','conversation.html'),'utf8');
      html=html.replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">`).replace('<style>',`<style nonce="${nonce}">`).replace('<script>',`<script nonce="${nonce}">`);
      created.webview.onDidReceiveMessage(async m=>{
        if(panel!==created)return;
        if(m?.jsonrpc==='2.0'&&m.method==='bridge/ready'){
          panelReady=true;
          if(selectedConversation)await created.webview.postMessage({jsonrpc:'2.0',method:'bridge/select',params:{conversation_id:selectedConversation}});
          return;
        }
        if(m?.jsonrpc!=='2.0'||m.id===undefined)return;
        const target=created;
        try{
          if(m.method!=='tools/call'||typeof m.params?.name!=='string')throw new Error('Unsupported panel request');
          if(!vscode.workspace.isTrusted)throw new Error('Workspace is not trusted');
          const result=await call(m.params.name,m.params.arguments||{});
          if(panel===target)await target.webview.postMessage({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}});
        }catch(error){if(panel===target)await target.webview.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:error.message}});}
      },null,context.subscriptions);
      created.onDidDispose(()=>{if(panel===created){panel=null;panelReady=false;}},null,context.subscriptions);
      if(panel===created)created.webview.html=html;
    }else panel.reveal(vscode.ViewColumn.Beside,true);
    if(panelReady&&conversation_id)await panel.webview.postMessage({jsonrpc:'2.0',method:'bridge/select',params:{conversation_id}});
  }
  context.subscriptions.push(vscode.commands.registerCommand('codexBridge.open',async()=>{
    try{await runtime();await open();}catch(error){vscode.window.showErrorMessage('Codex Bridge: '+error.message+'. Start the configured MCP server first.');}
  }));
  const timer=setInterval(async()=>{
    if(checking||!vscode.workspace.isTrusted||!vscode.workspace.getConfiguration('codexBridge').get('autoOpen'))return;checking=true;
    try{const r=await call('codex_list');if(r.open_sequence>lastSequence){lastSequence=r.open_sequence;await open(r.open_conversation);}}catch{}finally{checking=false;}
  },1500);
  context.subscriptions.push({dispose(){clearInterval(timer);panel?.dispose();}});
}
module.exports={activate};
