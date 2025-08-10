import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import './index.css';
import { FiUpload, FiPlay, FiStopCircle, FiRefreshCcw, FiTrash2, FiFile } from 'react-icons/fi';

const API = 'http://localhost:4000';

function App(){
  const [bots, setBots] = useState([]);
  const [selected, setSelected] = useState(null);
  const [files, setFiles] = useState([]);
  const [curFile, setCurFile] = useState(null);
  const [content, setContent] = useState('');
  const [logs, setLogs] = useState([]);
  const wsRef = useRef(null);

  useEffect(()=>{ fetchBots(); }, []);

  async function fetchBots(){
    const res = await fetch(`${API}/api/bots`);
    const data = await res.json();
    setBots(data);
  }

  async function upload(e){
    const f = e.target.files[0];
    if(!f) return;
    const fd = new FormData();
    fd.append('file', f);
    await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
    e.target.value = '';
    await fetchBots();
  }

  async function selectBot(b){
    setSelected(b);
    setFiles([]); setCurFile(null); setContent('');
    const res = await fetch(`${API}/api/bots/${b.id}/files`);
    const data = await res.json();
    setFiles(data);
    connectLogs(b.id);
  }

  function connectLogs(botId){
    if(wsRef.current){ wsRef.current.close(); wsRef.current = null; }
    const ws = new WebSocket(`ws://localhost:4000/ws/logs?botId=${botId}`);
    ws.onopen = ()=> setLogs([]);
    ws.onmessage = (ev)=> {
      try{
        const data = JSON.parse(ev.data);
        if(data.type === 'history') setLogs(prev => [...prev, ...data.logs].slice(-1000));
        if(data.type === 'log') setLogs(prev => [...prev, data.message].slice(-1000));
      }catch(e){}
    };
    wsRef.current = ws;
  }

  async function loadFile(f){
    const res = await fetch(`${API}/api/bots/${selected.id}/file?path=${encodeURIComponent(f.path)}`);
    const data = await res.json();
    setCurFile(f.path);
    setContent(data.content);
  }

  async function saveFile(){
    if(!curFile) return alert('No file selected');
    await fetch(`${API}/api/bots/${selected.id}/file`, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: curFile, content })
    });
    alert('Saved');
  }

  async function startBot(){
    await fetch(`${API}/api/bots/${selected.id}/start`, { method: 'POST' });
    fetchBots();
  }
  async function stopBot(){
    await fetch(`${API}/api/bots/${selected.id}/stop`, { method: 'POST' });
    fetchBots();
  }
  async function restartBot(){
    await fetch(`${API}/api/bots/${selected.id}/restart`, { method: 'POST' });
    fetchBots();
  }
  async function deleteBot(){
    if(!confirm('Delete bot?')) return;
    await fetch(`${API}/api/bots/${selected.id}`, { method: 'DELETE' });
    setSelected(null);
    fetchBots();
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="head">
          <div><strong>Bots</strong></div>
          <div className="small">Node20 + Docker</div>
        </div>

        <div style={{marginBottom:8}}>
          <label style={{display:'inline-flex',alignItems:'center',gap:6,cursor:'pointer'}}>
            <FiUpload /> <input type="file" accept=".zip" onChange={upload} style={{display:'inline-block'}} />
          </label>
          <button onClick={fetchBots} style={{marginLeft:8}}><FiRefreshCcw/></button>
        </div>

        <div className="bot-list">
          {bots.map(b => (
            <div key={b.id} className={`bot-item ${b.running ? 'running' : ''}`} onClick={()=>selectBot(b)}>
              <div style={{display:'flex',justifyContent:'space-between'}}>
                <div><strong>{b.id}</strong></div>
                <div className="small">{b.running ? 'Running' : 'Stopped'}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="controls">
          {selected && (
            <>
              <button onClick={startBot}><FiPlay/> Start</button>
              <button onClick={stopBot}><FiStopCircle/> Stop</button>
              <button onClick={restartBot}><FiRefreshCcw/> Restart</button>
              <button onClick={deleteBot}><FiTrash2/> Delete</button>
            </>
          )}
        </div>
      </div>

      <div className="main">
        <div className="topbar">
          <div>
            <h3>{selected ? `Bot: ${selected.id}` : 'No bot selected'}</h3>
          </div>
          <div className="small">Make sure server (with Docker) is running</div>
        </div>

        <div className="content">
          <div className="file-tree">
            <h4>Files</h4>
            {files.length === 0 && <div className="small">No files</div>}
            {files.map(f => (
              <div key={f.path} className="file-entry" onClick={()=>loadFile(f)}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <FiFile/> <div style={{wordBreak:'break-all'}}>{f.path}</div>
                </div>
                <div className="small">{f.size} bytes</div>
              </div>
            ))}
          </div>

          <div className="editor-area">
            <div className="toolbar">
              <div>Editing: <strong>{curFile || '-'}</strong></div>
              <div style={{marginLeft:'auto',display:'flex',gap:8}}>
                <button onClick={saveFile} disabled={!curFile}>Save</button>
              </div>
            </div>

            <div style={{flex:1,display:'flex',flexDirection:'column'}}>
              <div style={{flex:1}}>
                <Editor
                  height="60vh"
                  language={curFile && curFile.endsWith('.js') ? "javascript" : "plaintext"}
                  value={content}
                  onChange={(v)=>setContent(v)}
                  theme="vs-dark"
                />
              </div>

              <div style={{padding:8}}>
                <h4>Console Logs</h4>
                <div className="console">
                  {logs.map((l,i) => <div key={i}>{l}</div>)}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
