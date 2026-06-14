
/* =========================================================
   dashboard-ext.js  —  LogPilot Phase 3-12 UI
   Interactive force-directed graph + rich evidence panels
   ========================================================= */

// ── Escape helper (safe to call before DOM ready) ─────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Colour palette for node types ─────────────────────────────────────────
const NODE_COLORS = {
  incident:         '#E24B4A',
  logs:             '#378ADD',
  metrics:          '#EF9F27',
  error_burst:      '#D85A30',
  deployment:       '#1D9E75',
  heal_action:      '#639922',
  related_incident: '#BA7517',
  memory_spike:     '#A32D2D',
  splunk:           '#534AB7',
  anomaly:          '#993C1D',
  trace:            '#0F6E56',
  default:          '#888780',
};

const EDGE_COLORS = {
  CAUSED_BY:         '#E24B4A',
  TRIGGERED:         '#D85A30',
  CORRELATED_LOG:    '#378ADD',
  CORRELATED_METRIC: '#EF9F27',
  CORRELATED_DEPLOY: '#1D9E75',
  CORRELATED_HEAL:   '#639922',
  SIMILAR_INCIDENT:  '#BA7517',
  PRECEDED_BY:       '#888780',
  default:           '#B4B2A9',
};

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 3 — Interactive Force-Directed Correlation Graph
// ═══════════════════════════════════════════════════════════════════════════

let _graphState = null; // { nodes, edges, sim, canvas, ctx, animId, selected, hoverId }

function renderCorrelationTab(graph) {
  const el = document.getElementById('tab-correlation');
  if (!el) return;

  const nodes = (graph.nodes || []).map(n => ({ ...n }));
  const edges = graph.edges || [];
  const confidence = graph.confidence || 0;

  if (!nodes.length) {
    el.innerHTML = '<div class="empty-state"><p>No correlation data available. Click <strong>AI Investigate</strong> to build the graph.</p></div>';
    return;
  }

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${Object.entries(NODE_COLORS).slice(0,7).map(([type,color]) =>
          `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text2)">
            <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span>${type}
          </span>`
        ).join('')}
      </div>
      <div style="font-size:11px;color:var(--text4)">Confidence: <strong style="color:var(--text2)">${Math.round(confidence*100)}%</strong> · ${nodes.length} nodes · ${edges.length} edges</div>
    </div>
    <div style="position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface2)">
      <canvas id="graph-canvas" width="600" height="340" style="width:100%;height:340px;cursor:grab;display:block"></canvas>
      <div id="graph-tooltip" style="position:absolute;pointer-events:none;background:var(--surface1);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;max-width:220px;display:none;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,.15)"></div>
    </div>
    <div id="graph-detail" style="margin-top:10px;display:none">
      <div class="section-label" style="margin-bottom:6px">Selected node</div>
      <div id="graph-detail-content" class="evidence-item" style="font-size:12px"></div>
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--text4)">
      Drag nodes · Scroll to zoom · Click to inspect · Double-click to expand neighbours
    </div>
  `;

  // Position nodes in a good initial layout
  const W = 600, H = 340;
  const cx = W / 2, cy = H / 2;
  nodes.forEach((n, i) => {
    if (n.type === 'incident') { n.x = cx; n.y = cy; n.fx = cx; n.fy = cy; }
    else {
      const angle = (i / (nodes.length - 1)) * 2 * Math.PI;
      const r = 110 + Math.random() * 40;
      n.x = cx + Math.cos(angle) * r;
      n.y = cy + Math.sin(angle) * r;
    }
    n.vx = 0; n.vy = 0;
    n.r = n.type === 'incident' ? 22 : 14;
  });

  if (_graphState?.animId) cancelAnimationFrame(_graphState.animId);

  const canvas = document.getElementById('graph-canvas');
  const ctx = canvas.getContext('2d');
  // Retina
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 600 * dpr; canvas.height = 340 * dpr;
  canvas.style.width = '100%'; canvas.style.height = '340px';
  ctx.scale(dpr, dpr);

  _graphState = { nodes, edges, canvas, ctx, selected: null, hoverId: null,
    zoom: 1, panX: 0, panY: 0, dragging: null, pinned: new Set() };

  // Force simulation (tick-based, no d3)
  let tick = 0;
  function simulate() {
    const { nodes, edges } = _graphState;
    const alpha = Math.max(0.01, 0.3 * Math.exp(-tick * 0.015));
    tick++;

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (1400 / (dist * dist)) * alpha;
        dx /= dist; dy /= dist;
        if (!a.fx) { a.vx -= dx * force; a.vy -= dy * force; }
        if (!b.fx) { b.vx += dx * force; b.vy += dy * force; }
      }
    }

    // Attraction along edges
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.from);
      const b = nodes.find(n => n.id === e.to);
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 130;
      const force = ((dist - target) / dist) * 0.08 * alpha;
      if (!a.fx) { a.vx += dx * force; a.vy += dy * force; }
      if (!b.fx) { b.vx -= dx * force; b.vy -= dy * force; }
    });

    // Centre gravity
    nodes.forEach(n => {
      if (n.fx) { n.x = n.fx; n.y = n.fy; return; }
      n.vx += (W / 2 - n.x) * 0.008 * alpha;
      n.vy += (H / 2 - n.y) * 0.008 * alpha;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
      // Clamp
      n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x));
      n.y = Math.max(n.r + 4, Math.min(H - n.r - 4, n.y));
    });
  }

  function draw() {
    const { nodes, edges, ctx, selected, hoverId, zoom, panX, panY } = _graphState;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // Draw edges first
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.from);
      const b = nodes.find(n => n.id === e.to);
      if (!a || !b) return;
      const isHighlighted = selected && (e.from === selected || e.to === selected);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = EDGE_COLORS[e.relation] || EDGE_COLORS.default;
      ctx.lineWidth   = isHighlighted ? 2.5 : 1;
      ctx.globalAlpha = isHighlighted ? 0.9 : (selected ? 0.15 : 0.45);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Arrow head
      if (isHighlighted || !selected) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(-8, -4); ctx.lineTo(-8, 4); ctx.closePath();
        ctx.fillStyle = EDGE_COLORS[e.relation] || EDGE_COLORS.default;
        ctx.globalAlpha = isHighlighted ? 0.9 : 0.4;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // Edge label on highlighted
      if (isHighlighted && e.relation) {
        const mx2 = (a.x + b.x) / 2, my2 = (a.y + b.y) / 2;
        ctx.font = '9px sans-serif';
        ctx.fillStyle = EDGE_COLORS[e.relation] || '#888';
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.8;
        ctx.fillText(e.relation.replace(/_/g, ' '), mx2, my2 - 6);
        ctx.globalAlpha = 1;
      }
    });

    // Draw nodes
    nodes.forEach(n => {
      const isSelected = selected === n.id;
      const isHover    = hoverId === n.id;
      const isDimmed   = selected && !isSelected && !edges.some(e => e.from === selected && e.to === n.id || e.to === selected && e.from === n.id);
      const color = NODE_COLORS[n.type] || NODE_COLORS.default;
      const r = n.r + (isHover ? 3 : 0);

      ctx.globalAlpha = isDimmed ? 0.2 : 1;

      // Glow for selected
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = color + '40';
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : color;
      ctx.lineWidth = isSelected ? 2.5 : 1;
      ctx.stroke();

      // Type icon letter
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${r > 16 ? 11 : 9}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((n.type || '?')[0].toUpperCase(), n.x, n.y);

      // Label below
      ctx.globalAlpha = isDimmed ? 0.15 : (isHover || isSelected ? 1 : 0.75);
      ctx.font = `${isSelected ? 'bold ' : ''}10px sans-serif`;
      ctx.fillStyle = 'var(--text1, #1a1a18)';
      const label = n.label.length > 22 ? n.label.slice(0, 20) + '…' : n.label;
      ctx.fillText(label, n.x, n.y + r + 10);
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'alphabetic';
    });

    ctx.restore();
  }

  function loop() {
    simulate();
    draw();
    _graphState.animId = requestAnimationFrame(loop);
  }
  loop();

  // ── Mouse interactions ────────────────────────────────────────────────
  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = 600 / rect.width;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top)  * scaleX;
    return { x: (x - _graphState.panX) / _graphState.zoom,
             y: (y - _graphState.panY) / _graphState.zoom };
  }

  function hitTest(pos) {
    return _graphState.nodes.find(n => {
      const dx = n.x - pos.x, dy = n.y - pos.y;
      return Math.sqrt(dx * dx + dy * dy) <= n.r + 6;
    });
  }

  let lastClick = 0;

  canvas.addEventListener('mousedown', e => {
    const pos = canvasPos(e);
    const node = hitTest(pos);
    if (node) {
      _graphState.dragging = node;
      node.fx = node.x; node.fy = node.y;
      canvas.style.cursor = 'grabbing';
    } else {
      _graphState._panStart = { mx: e.clientX, my: e.clientY, px: _graphState.panX, py: _graphState.panY };
    }
  });

  canvas.addEventListener('mousemove', e => {
    const pos = canvasPos(e);
    const node = hitTest(pos);
    _graphState.hoverId = node ? node.id : null;
    canvas.style.cursor = node ? 'pointer' : (_graphState.dragging ? 'grabbing' : 'grab');

    // Tooltip
    const tip = document.getElementById('graph-tooltip');
    if (node && tip) {
      const rect = canvas.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = (e.clientX - rect.left + 12) + 'px';
      tip.style.top  = (e.clientY - rect.top  - 10) + 'px';
      const connCount = _graphState.edges.filter(ed => ed.from === node.id || ed.to === node.id).length;
      tip.innerHTML = `<strong>${esc(node.label)}</strong><br>
        <span style="color:var(--text4)">${esc(node.type)}</span><br>
        <span style="color:var(--text4)">${connCount} connection${connCount !== 1 ? 's' : ''}</span>
        ${node.data?.confidence ? `<br><span style="color:var(--text4)">confidence: ${node.data.confidence}%</span>` : ''}`;
    } else if (tip) {
      tip.style.display = 'none';
    }

    if (_graphState.dragging) {
      _graphState.dragging.fx = pos.x;
      _graphState.dragging.fy = pos.y;
    } else if (_graphState._panStart) {
      _graphState.panX = _graphState._panStart.px + (e.clientX - _graphState._panStart.mx);
      _graphState.panY = _graphState._panStart.py + (e.clientY - _graphState._panStart.my);
    }
  });

  canvas.addEventListener('mouseup', e => {
    const now = Date.now();
    const pos = canvasPos(e);
    const node = hitTest(pos);

    if (_graphState.dragging && !node) {
      // Released in empty space — unpin
    }

    if (node) {
      // Double-click: release pin and let it float
      if (now - lastClick < 300) {
        node.fx = undefined; node.fy = undefined;
        _graphState.pinned.delete(node.id);
      } else {
        // Single click: select + show detail
        _graphState.selected = _graphState.selected === node.id ? null : node.id;
        showNodeDetail(node);
      }
      lastClick = now;
    } else {
      _graphState.selected = null;
      document.getElementById('graph-detail').style.display = 'none';
    }

    if (_graphState.dragging) {
      // Pin dragged node in place
      _graphState.dragging.fx = _graphState.dragging.x;
      _graphState.dragging.fy = _graphState.dragging.y;
      _graphState.pinned.add(_graphState.dragging.id);
      _graphState.dragging = null;
    }
    _graphState._panStart = null;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    _graphState.zoom = Math.max(0.4, Math.min(3, _graphState.zoom * factor));
  }, { passive: false });

  canvas.addEventListener('mouseleave', () => {
    _graphState.hoverId = null;
    const tip = document.getElementById('graph-tooltip');
    if (tip) tip.style.display = 'none';
  });
}

function showNodeDetail(node) {
  const wrap = document.getElementById('graph-detail');
  const el   = document.getElementById('graph-detail-content');
  if (!wrap || !el) return;
  wrap.style.display = 'block';
  const d = node.data || {};
  const connEdges = (_graphState?.edges || []).filter(e => e.from === node.id || e.to === node.id);
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="width:10px;height:10px;border-radius:50%;background:${NODE_COLORS[node.type]||NODE_COLORS.default};display:inline-block;flex-shrink:0"></span>
      <strong>${esc(node.label)}</strong>
      <span style="font-size:10px;color:var(--text4);background:var(--surface2);padding:1px 6px;border-radius:10px">${esc(node.type)}</span>
    </div>
    ${Object.entries(d).filter(([k,v]) => v != null && String(v).length < 80).map(([k,v]) =>
      `<div style="margin-bottom:2px"><span style="color:var(--text4);width:100px;display:inline-block">${esc(k)}:</span> <span>${esc(String(v))}</span></div>`
    ).join('')}
    ${connEdges.length ? `<div style="margin-top:6px;color:var(--text4);font-size:11px">
      Connected via: ${[...new Set(connEdges.map(e => e.relation))].join(', ')}
    </div>` : ''}
    <div style="margin-top:8px;font-size:11px;color:var(--text4)">Double-click node to release pin · Drag to reposition</div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 2 — Rich Evidence Tab
// ═══════════════════════════════════════════════════════════════════════════

function renderEvidenceTab(evidence) {
  const el = document.getElementById('tab-evidence');
  if (!el) return;

  // Store evidence on the element so live refresh can diff changes
  el._evidenceData = evidence;

  const logs      = evidence.logs      || {};
  const metrics   = evidence.metrics   || {};
  const heals     = evidence.heals     || {};
  const related   = evidence.relatedIncidents || {};
  const anomalies = evidence.anomalies || {};
  const deploys   = evidence.deployments || {};

  const srcSplunk = evidence.source === 'splunk';
  const splunkDown = evidence.splunkStatus === 'unreachable';
  const srcColor  = srcSplunk ? '#1D9E75' : (splunkDown ? '#EF9F27' : '#378ADD');
  const errRate   = logs.errorRate != null ? logs.errorRate : null;
  const hasData   = logs.count > 0 || metrics.samples > 0 || anomalies.count > 0 || heals.count > 0;

  // ── Severity colour helper ─────────────────────────────────────────────
  function sevColor(sev) {
    return sev === 'critical' ? '#E24B4A' : sev === 'high' ? '#D85A30' : sev === 'warning' ? '#EF9F27' : '#9ca3af';
  }

  function statusColor(code) {
    const n = parseInt(code);
    return n >= 500 ? '#E24B4A' : n >= 400 ? '#EF9F27' : n >= 200 ? '#1D9E75' : '#9ca3af';
  }

  // ── Sparkline renderer (pure SVG, no deps) ────────────────────────────
  function sparkline(series, key, color, height = 28, showZero = false) {
    const vals = series.map(p => p[key]).filter(v => v != null);
    if (!vals.length) return `<span style="font-size:10px;color:#9ca3af">no data</span>`;
    const max  = Math.max(...vals) || 1;
    const min  = Math.min(...vals);
    const range = max - min || 1;
    const W = 80, H = height;
    const pts = vals.map((v, i) => {
      const x = Math.round((i / (vals.length - 1 || 1)) * W);
      const y = Math.round(H - ((v - min) / range) * (H - 2) - 1);
      return `${x},${y}`;
    }).join(' ');
    const last = vals[vals.length - 1];
    const pct  = max > 0 ? Math.round((last / max) * 100) : 0;
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${vals.length > 1 ? Math.round(((vals.length-1)/(vals.length-1||1))*W) : W}" cy="${Math.round(H - ((last-min)/range)*(H-2) - 1)}" r="2.5" fill="${color}"/>
    </svg>`;
  }

  // ── Mini bar chart for error frequency ───────────────────────────────
  function errorBar(count, total, color) {
    const pct = total ? Math.min(100, Math.round((count / total) * 100)) : 0;
    return `<div style="display:flex;align-items:center;gap:6px;margin-top:4px">
      <div style="flex:1;height:5px;background:#f1f5f9;border-radius:3px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:3px;transition:width .6s cubic-bezier(.4,0,.2,1)"></div>
      </div>
      <span style="font-size:10px;color:#9ca3af;width:28px;text-align:right">${pct}%</span>
    </div>`;
  }

  // ── Metric gauge bar ──────────────────────────────────────────────────
  function gaugeBar(value, spike, unit = '%') {
    const pct   = unit === '%' ? Math.min(100, value) : Math.min(100, (value / 2000) * 100);
    const color = spike ? '#E24B4A' : value > 60 ? '#EF9F27' : '#378ADD';
    return `<div style="height:8px;background:#f1f5f9;border-radius:4px;overflow:hidden;margin-top:4px">
      <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width .8s cubic-bezier(.4,0,.2,1)"></div>
    </div>`;
  }

  // ── Error timeline mini-chart ─────────────────────────────────────────
  function renderTimeline(buckets) {
    if (!buckets || !buckets.length) return '';
    const maxErr = Math.max(...buckets.map(b => b.errors), 1);
    const H = 32, W = Math.min(buckets.length * 10, 280);
    const barW = Math.floor(W / buckets.length) - 1;
    const bars = buckets.map((b, i) => {
      const h = Math.max(2, Math.round((b.errors / maxErr) * H));
      const color = b.errors > 0 ? (b.errors >= maxErr * 0.7 ? '#E24B4A' : '#EF9F27') : '#e2e8f0';
      return `<rect x="${i*(barW+1)}" y="${H-h}" width="${barW}" height="${h}" fill="${color}" rx="1"/>`;
    }).join('');
    return `<div style="margin-top:8px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px">Error frequency (5-min buckets)</div>
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bars}</svg>
    </div>`;
  }

  // ── Build HTML ────────────────────────────────────────────────────────
  el.innerHTML = `
  <div id="evidence-root" style="display:flex;flex-direction:column;gap:12px">

  <!-- Header row: source + timestamp + refresh -->
  <div style="display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:8px;height:8px;border-radius:50%;background:${srcColor};display:inline-block"></span>
      <span style="font-size:12px;font-weight:600;color:${srcColor}">${srcSplunk ? 'Splunk evidence' : (splunkDown ? 'Local evidence (Splunk unreachable)' : 'Local evidence')}</span>
      ${hasData ? `<span id="ev-live-badge" style="font-size:10px;padding:1px 6px;border-radius:10px;background:#dcfce7;color:#16a34a;cursor:pointer" onclick="startEvidenceLiveRefresh()">● Live</span>` : ''}
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:10px;color:#9ca3af" id="ev-ts">${evidence.timestamp ? new Date(evidence.timestamp).toLocaleTimeString() : ''}</span>
      <button onclick="refreshEvidence()" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid #e2e8f0;background:transparent;cursor:pointer;color:#4b5563">↻ Refresh</button>
    </div>
  </div>

  <!-- KPI row -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
    ${[
      { label: 'Log Events',       value: logs.count || 0,      color: logs.count > 0 ? '#378ADD' : '#9ca3af', icon: '📋',
        chart: logs.errorTimeline?.length ? renderTimeline(logs.errorTimeline.map(b => ({ errors: b.total ?? b.errors ?? 0 }))) : '' },
      { label: 'Error Rate',       value: errRate != null ? errRate + '%' : '—',
        color: errRate > 20 ? '#E24B4A' : errRate > 5 ? '#EF9F27' : '#1D9E75', icon: '⚠',
        chart: logs.errorTimeline?.length ? renderTimeline(logs.errorTimeline) : '' },
      { label: 'Max Response',     value: logs.maxResponseMs ? logs.maxResponseMs + 'ms' : '—',
        color: (logs.maxResponseMs||0) > 3000 ? '#E24B4A' : (logs.maxResponseMs||0) > 1000 ? '#EF9F27' : '#1D9E75', icon: '⏱',
        chart: metrics.series?.length > 1 ? `<div style="margin-top:4px">${sparkline(metrics.series, 'lag', '#D97706', 22)}</div>` : '' },
      { label: 'Anomalies',        value: anomalies.count || 0,
        color: anomalies.count > 0 ? '#E24B4A' : '#1D9E75', icon: '🔍', chart: '' },
      { label: 'Heal Actions',     value: heals.count || 0,     color: heals.count > 0 ? '#1D9E75' : '#9ca3af', icon: '🛠', chart: '' },
      { label: 'Related Incidents', value: related.count || 0,  color: related.count > 0 ? '#EF9F27' : '#9ca3af', icon: '🔗', chart: '' },
    ].map(k => `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px">${k.icon} ${k.label}</div>
        <div style="font-size:20px;font-weight:700;color:${k.color};line-height:1">${k.value}</div>
        ${k.chart || ''}
      </div>`).join('')}
  </div>

  <!-- Anomalies — interactive, expandable cards -->
  ${anomalies.detected?.length ? `
  <div>
    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
      Detected Anomalies
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
    ${anomalies.detected.map((a, i) => {
      const sc = sevColor(a.severity);
      const bg = a.severity === 'critical' ? '#fef2f2' : a.severity === 'high' ? '#fff7ed' : '#fffbeb';
      const borderL = `3px solid ${sc}`;
      const icons = { high_cpu: '🖥', high_memory: '💾', event_loop: '🔄', slow_response: '🐢', error_rate: '📛' };
      const pct = a.unit === '%' ? Math.min(100, a.value) : Math.min(100, Math.round((a.value / (a.unit === 'ms' ? 5000 : 100)) * 100));
      return `
      <div style="background:${bg};border-left:${borderL};border-radius:0 8px 8px 0;padding:10px 12px;cursor:pointer"
           onclick="toggleAnomalyDetail('ad-${i}')">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:16px">${icons[a.type] || '⚡'}</span>
            <div>
              <div style="font-size:12px;font-weight:600;color:#1f2937">${esc(a.message)}</div>
              <div style="font-size:10px;color:#6b7280;margin-top:1px">${esc(a.type.replace(/_/g,' '))} · threshold: ${a.threshold}${a.unit||''}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${sc}20;color:${sc}">
              ${esc(a.severity).toUpperCase()}
            </span>
            <span style="font-size:11px;color:#9ca3af" id="ad-${i}-arrow">▼</span>
          </div>
        </div>
        <div style="margin-top:6px">
          <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${sc};border-radius:3px;transition:width .8s ease"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:#9ca3af;margin-top:2px">
            <span>0</span><span style="color:${sc};font-weight:600">${a.value}${a.unit||''}</span><span>${a.unit==='%' ? '100%' : a.unit==='ms' ? '5000ms' : '100'}</span>
          </div>
        </div>
        <!-- Expandable detail -->
        <div id="ad-${i}" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid ${sc}30">
          <div style="font-size:11px;color:#374151;line-height:1.6">
            <strong>Impact:</strong> ${a.severity === 'critical' ? 'Service degraded, immediate action required.' : a.severity === 'high' ? 'Performance impacted, investigate soon.' : 'Minor deviation, monitor for escalation.'}<br>
            <strong>Current value:</strong> ${a.value}${a.unit||''} (${Math.round(((a.value - a.threshold) / a.threshold) * 100)}% above threshold)<br>
            <strong>Recommended action:</strong> ${
              a.type === 'high_memory' ? 'Force GC or capture heap snapshot. Check for memory leaks.' :
              a.type === 'high_cpu' ? 'Check for blocking operations. Consider horizontal scaling.' :
              a.type === 'event_loop' ? 'Identify synchronous blocking code. Use setImmediate() for heavy tasks.' :
              a.type === 'slow_response' ? 'Check DB queries, external calls, and N+1 patterns.' :
              a.type === 'error_rate' ? 'Review error logs below. Check downstream dependencies.' :
              'Review logs and metrics for correlated signals.'}
          </div>
          <button onclick="event.stopPropagation();showAnomalyInCorrelation('${a.type}')"
            style="margin-top:8px;font-size:11px;padding:3px 10px;border-radius:6px;border:1px solid ${sc};background:transparent;color:${sc};cursor:pointer">
            View in correlation graph →
          </button>
        </div>
      </div>`;
    }).join('')}
    </div>
  </div>` : (hasData ? `<div style="padding:8px 12px;background:#f0fdf4;border-radius:8px;font-size:12px;color:#16a34a">✓ No anomalies detected in current observation window</div>` : '')}

  <!-- System Metrics with sparklines -->
  <div>
    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
      System Metrics
      <span style="font-size:10px;font-weight:400;color:#9ca3af;margin-left:6px">${metrics.samplesWithData || metrics.samples || 0} samples with data</span>
    </div>
    ${metrics.samplesWithData > 0 || metrics.samples > 0 ? `
    <div style="display:flex;flex-direction:column;gap:6px">
    ${[
      { label: 'CPU Usage',        key: 'cpu', max: metrics.maxCpu,         avg: metrics.avgCpu,    spike: metrics.cpuSpike,         unit: '%',  color: '#7C3AED' },
      { label: 'Memory Usage',     key: 'mem', max: metrics.maxMemory,      avg: metrics.avgMemory, spike: metrics.memorySpike,      unit: '%',  color: '#0891B2' },
      { label: 'Event Loop Lag',   key: 'lag', max: metrics.maxEventLoopLag, avg: null,              spike: metrics.eventLoopLagSpike, unit: 'ms', color: '#D97706' },
    ].map(m => {
      const hasVal  = m.max > 0;
      const sc      = m.spike ? '#E24B4A' : m.max > 60 ? '#EF9F27' : '#4b5563';
      const pct     = m.unit === '%' ? Math.min(100, m.max) : Math.min(100, Math.round((m.max / 2000) * 100));
      const barColor = m.spike ? '#E24B4A' : m.max > 60 ? '#EF9F27' : m.color;
      const series  = metrics.series || [];
      return `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div>
            <span style="font-size:12px;font-weight:600;color:#374151">${m.label}</span>
            ${m.spike ? `<span style="margin-left:6px;font-size:10px;font-weight:700;color:#E24B4A">⚠ SPIKE</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            ${m.avg != null && m.avg > 0 ? `<span style="font-size:11px;color:#9ca3af">avg <strong>${m.avg}${m.unit}</strong></span>` : ''}
            <span style="font-size:14px;font-weight:700;color:${sc}">${hasVal ? m.max + m.unit : '—'}</span>
            ${series.length > 1 ? sparkline(series, m.key, m.color) : ''}
          </div>
        </div>
        ${hasVal ? `
        <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px;transition:width .8s cubic-bezier(.4,0,.2,1)"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#9ca3af;margin-top:2px">
          <span>0</span><span style="color:${sc};font-weight:600">${m.max}${m.unit}</span><span>${m.unit === '%' ? '100%' : '2000ms'}</span>
        </div>` : `<div style="font-size:11px;color:#9ca3af;padding:4px 0">No ${m.label.toLowerCase()} data in observation window</div>`}
      </div>`;
    }).join('')}
    </div>
    ${renderTimeline(logs.errorTimeline)}
    ` : `<div style="padding:10px 12px;background:#f8fafc;border-radius:8px;font-size:12px;color:#9ca3af">
      No metric samples recorded yet. Metrics are collected every 5 seconds while the app is running.
    </div>`}
  </div>

  <!-- Dominant Errors -->
  ${logs.dominantErrors?.length ? `
  <div>
    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
      Dominant Errors <span style="font-size:10px;font-weight:400;color:#9ca3af">${logs.dominantErrors.length} unique patterns</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px">
    ${logs.dominantErrors.map((e, i) => {
      const pct = logs.count ? Math.round((e.count / logs.count) * 100) : 0;
      const hue = i === 0 ? '#E24B4A' : i === 1 ? '#D85A30' : i === 2 ? '#EF9F27' : '#9ca3af';
      return `
      <div style="background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
          <code style="font-size:11px;color:#dc2626;flex:1;word-break:break-all;line-height:1.5">${esc(e.message)}</code>
          <div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0">
            <span style="font-size:12px;font-weight:700;color:${hue}">${e.count}×</span>
            <span style="font-size:10px;color:#9ca3af">${pct}% of errors</span>
          </div>
        </div>
        <div style="height:5px;background:#fee2e2;border-radius:3px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${hue};border-radius:3px;transition:width .7s ease"></div>
        </div>
      </div>`;
    }).join('')}
    </div>
  </div>` : ''}

  <!-- Status Code Breakdown -->
  ${logs.statusCodes && Object.keys(logs.statusCodes).filter(k => k !== '0').length ? `
  <div>
    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Status Codes</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
    ${Object.entries(logs.statusCodes).filter(([k]) => k !== '0').sort(([a],[b]) => parseInt(b)-parseInt(a)).map(([code, count]) => {
      const c = statusColor(code);
      return `<div style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;background:${c}15;border:1px solid ${c}40">
        <span style="font-size:12px;font-weight:700;color:${c}">${esc(code)}</span>
        <span style="font-size:11px;color:#6b7280">${count}</span>
      </div>`;
    }).join('')}
    </div>
  </div>` : ''}

  <!-- Response Time Stats -->
  ${logs.avgResponseMs > 0 || logs.p95ResponseMs > 0 ? `
  <div>
    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Response Times</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
      ${[['Avg', logs.avgResponseMs], ['P95', logs.p95ResponseMs], ['Max', logs.maxResponseMs]].map(([lbl, val]) => {
        const c = val > 3000 ? '#E24B4A' : val > 1000 ? '#EF9F27' : '#1D9E75';
        return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:10px;color:#9ca3af">${lbl}</div>
          <div style="font-size:16px;font-weight:700;color:${c}">${val ? val + 'ms' : '—'}</div>
        </div>`;
      }).join('')}
    </div>
  </div>` : ''}

  <!-- Heal Actions -->
  ${heals.recentActions?.length ? `
  <div>
    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Heal Actions</div>
    <div style="display:flex;flex-direction:column;gap:4px">
    ${heals.recentActions.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:14px">🛠</span>
          <span style="font-size:12px;font-weight:600;font-family:monospace;color:#15803d">${esc(a.action)}</span>
        </div>
        <span style="font-size:11px;background:#dcfce7;color:#16a34a;padding:1px 8px;border-radius:10px">${a.count}×</span>
      </div>`).join('')}
    </div>
  </div>` : ''}

  <!-- Related Incidents -->
  ${related.similar?.length ? `
  <div>
    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Related Incidents</div>
    <div style="display:flex;flex-direction:column;gap:4px">
    ${related.similar.slice(0, 5).map(r => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;cursor:pointer"
           onclick="typeof closeModal==='function'&&closeModal();typeof openIncidentModal==='function'&&openIncidentModal('${r.incidentId}')">
        <div>
          <div style="font-size:12px;font-weight:600;color:#374151">${esc(r.title || r.path || 'Incident #' + r.incidentId)}</div>
          <div style="font-size:10px;color:#9ca3af;margin-top:1px">${esc(r.rootCause || '')}</div>
        </div>
        <span style="font-size:11px;color:#d97706">→</span>
      </div>`).join('')}
    </div>
  </div>` : ''}

  <!-- Empty state -->
  ${!hasData ? `
  <div style="text-align:center;padding:32px 16px;color:#9ca3af">
    <div style="font-size:32px;margin-bottom:10px">🔍</div>
    <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:6px">No evidence collected yet</div>
    <div style="font-size:12px;line-height:1.6">
      Evidence is gathered from logs, metrics, and heal actions recorded in the last 15–60 minutes.<br>
      Click <strong style="color:#374151">🤖 AI Investigate</strong> to trigger a fresh collection.
    </div>
  </div>` : ''}

  </div><!-- #evidence-root -->
  `;

  // Auto-start live refresh when tab is active and has data
  if (hasData) startEvidenceLiveRefresh();
}

// ── Live evidence refresh (polls every 15s while tab is visible) ──────────
let _evidencePollTimer = null;
let _evidencePollId    = null;

function startEvidenceLiveRefresh() {
  stopEvidenceLiveRefresh();
  const badge = document.getElementById('ev-live-badge');
  if (badge) badge.style.background = '#dcfce7';

  _evidencePollTimer = setInterval(() => {
    const el = document.getElementById('tab-evidence');
    if (!el || el.style.display === 'none') { stopEvidenceLiveRefresh(); return; }
    if (typeof activeModal === 'undefined' || !activeModal) { stopEvidenceLiveRefresh(); return; }
    refreshEvidence();
  }, 15000);
}

function stopEvidenceLiveRefresh() {
  if (_evidencePollTimer) { clearInterval(_evidencePollTimer); _evidencePollTimer = null; }
  const badge = document.getElementById('ev-live-badge');
  if (badge) badge.style.background = '#f1f5f9';
}

function refreshEvidence() {
  if (typeof activeModal === 'undefined' || !activeModal) return;
  const tsEl = document.getElementById('ev-ts');
  if (tsEl) tsEl.textContent = 'Refreshing…';

  fetch('/api/incidents/' + activeModal + '/evidence')
    .then(r => r.json())
    .then(data => {
      renderEvidenceTab(data);
      // Animate the KPI numbers that changed
      _flashChangedKPIs(data);
    })
    .catch(() => {
      if (tsEl) tsEl.textContent = 'Refresh failed';
    });
}

function _flashChangedKPIs(newData) {
  // Brief pulse animation on updated values — purely CSS class toggle
  const root = document.getElementById('evidence-root');
  if (!root) return;
  root.querySelectorAll('[style*="font-size:20px"]').forEach(el => {
    el.style.transition = 'color .3s ease';
    el.style.opacity = '0.5';
    setTimeout(() => { el.style.opacity = '1'; }, 300);
  });
}

function toggleAnomalyDetail(id) {
  const el    = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display    = open ? 'none' : 'block';
  if (arrow) arrow.textContent = open ? '▼' : '▲';
}

function showAnomalyInCorrelation(anomalyType) {
  // Switch to the correlation tab and highlight the anomaly node
  const corrBtn = document.querySelector('.tab-btn[onclick*="correlation"]');
  if (corrBtn) corrBtn.click();
}


// ═══════════════════════════════════════════════════════════════════════════
//  SIMILAR INCIDENTS TAB
// ═══════════════════════════════════════════════════════════════════════════

function renderSimilarTab(similar) {
  const el = document.getElementById('tab-similar');
  if (!el) return;
  if (!similar?.length) {
    el.innerHTML = `
      <div class="empty-state">
        <p>No similar historical incidents found.</p>
        <p style="font-size:12px;color:var(--text4);margin-top:6px">
          Similar incidents are identified by matching endpoint path, root cause, error messages, and status codes.
          More incidents need to be recorded before patterns emerge.
        </p>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="section-label" style="margin-bottom:8px">${similar.length} similar past incident${similar.length !== 1 ? 's' : ''}</div>
    ${similar.map(s => {
      const simColor = s.similarity >= 70 ? 'var(--red)' : s.similarity >= 40 ? 'var(--yellow)' : 'var(--text4)';
      const simWidth = Math.max(4, s.similarity);
      return `
      <div class="event-item" style="cursor:pointer;margin-bottom:8px" onclick="closeModal && closeModal();openIncidentModal && openIncidentModal('${s.incidentId}')">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-weight:600;font-size:13px">${esc(s.title || 'Incident #' + s.incidentId)}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="width:60px;height:5px;background:var(--surface2);border-radius:3px;overflow:hidden">
              <div style="width:${simWidth}%;height:100%;background:${simColor};border-radius:3px"></div>
            </div>
            <span style="font-size:11px;color:${simColor};font-weight:600">${s.similarity}%</span>
          </div>
        </div>
        <div style="display:flex;gap:10px;font-size:11px;color:var(--text4);margin-bottom:5px;flex-wrap:wrap">
          ${s.path ? `<span>📍 ${esc(s.path)}</span>` : ''}
          ${s.rootCause ? `<span>🔍 ${esc(s.rootCause)}</span>` : ''}
          ${s.eventCount ? `<span>📊 ${s.eventCount} events</span>` : ''}
          ${s.severity ? `<span>⚡ ${esc(s.severity)}</span>` : ''}
        </div>
        <div style="font-size:12px;display:flex;gap:12px;flex-wrap:wrap">
          ${s.resolution && s.resolution !== 'no action recorded' ? `
          <span><span style="color:var(--text4)">Resolution:</span> <code style="font-size:11px;color:var(--green)">${esc(s.resolution)}</code></span>` : ''}
          ${s.outcome && s.outcome !== 'unknown' ? `
          <span><span style="color:var(--text4)">Outcome:</span> <span style="color:${s.outcome.includes('resolved') ? 'var(--green)' : 'var(--text2)'}">${esc(s.outcome)}</span></span>` : ''}
        </div>
      </div>`;
    }).join('')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RECOMMENDATIONS TAB
// ═══════════════════════════════════════════════════════════════════════════

function renderRecommendationsTab(recs) {
  const el = document.getElementById('tab-recommendations');
  if (!el) return;
  if (!recs?.length) {
    el.innerHTML = '<div class="empty-state"><p>No recommendations available. Click <strong>AI Investigate</strong> to generate them.</p></div>';
    return;
  }
  const actionIcons = {
    'gc': '🗑', 'restart-service': '🔄', 'rollback-deployment': '⏪',
    'circuit-break': '⚡', 'rate-limit': '🛡', 'heap-snapshot': '📸',
    'scale-replicas': '📈', 'notify-only': '🔔',
  };
  el.innerHTML = `
    <div class="section-label" style="margin-bottom:8px">${recs.length} ranked actions</div>
    ${recs.map((r, i) => {
      const pColor = r.priority === 1 ? 'var(--red)' : r.priority === 2 ? 'var(--yellow)' : 'var(--text4)';
      const pLabel = r.priority === 1 ? 'High priority' : r.priority === 2 ? 'Medium' : 'Low';
      const confPct = Math.round((r.confidence || 0) * 100);
      return `
      <div class="event-item" style="margin-bottom:8px;border-left:3px solid ${pColor}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:16px">${actionIcons[r.action] || '⚙'}</span>
            <span style="font-weight:600;font-size:13px;font-family:monospace">${esc(r.action)}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span style="font-size:10px;color:${pColor};font-weight:600">${pLabel}</span>
            <div style="width:40px;height:5px;background:var(--surface2);border-radius:3px;overflow:hidden">
              <div style="width:${confPct}%;height:100%;background:var(--blue);border-radius:3px"></div>
            </div>
            <span style="font-size:11px;color:var(--text4)">${confPct}%</span>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text2);line-height:1.5">${esc(r.reasoning)}</div>
        ${r.historicalBasis ? `<div style="font-size:10px;color:var(--text4);margin-top:4px">📊 Based on ${r.historicalBasis ? 'historical' : ''} incident patterns</div>` : ''}
      </div>`;
    }).join('')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RECOVERY TAB
// ═══════════════════════════════════════════════════════════════════════════

function renderRecoveryTab(recovery) {
  const el = document.getElementById('tab-recovery');
  if (!el) return;
  const resolved = recovery.resolved;
  const errRate  = recovery.errorRate || 0;

  el.innerHTML = `
    <div style="text-align:center;padding:16px 0 20px">
      <div style="font-size:36px;margin-bottom:6px">${resolved ? '✅' : '⚠️'}</div>
      <div style="font-size:18px;font-weight:600;color:${resolved ? 'var(--green)' : 'var(--yellow)'}">${resolved ? 'Resolved' : 'Still active'}</div>
      <div style="font-size:12px;color:var(--text4);margin-top:4px">Confidence: ${recovery.confidence || 0}%</div>
    </div>
    <div class="analysis-grid" style="margin-bottom:14px">
      <div class="analysis-box">
        <div class="analysis-label">Error Rate</div>
        <div class="analysis-value" style="color:${errRate > 10 ? 'var(--red)' : errRate > 5 ? 'var(--yellow)' : 'var(--green)'}">${errRate}%</div>
      </div>
      <div class="analysis-box">
        <div class="analysis-label">Requests</div>
        <div class="analysis-value">${recovery.totalRequests || 0}</div>
      </div>
      <div class="analysis-box">
        <div class="analysis-label">Errors</div>
        <div class="analysis-value" style="color:${(recovery.errorCount||0)>0?'var(--red)':'var(--green)'}">${recovery.errorCount || 0}</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text4);display:flex;gap:12px;flex-wrap:wrap">
      <span>Source: ${esc(recovery.source || 'local')}</span>
      <span>Window: ${Math.round((recovery.windowMs || 0) / 60000)} min</span>
      <span>Checked: ${recovery.checkedAt ? new Date(recovery.checkedAt).toLocaleTimeString() : '—'}</span>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  AI RCA TAB (from renderIncidentAnalysis + runAIInvestigation)
// ═══════════════════════════════════════════════════════════════════════════

function renderIncidentAnalysis(data) {
  const ctx = data.context || {};
  const rca = data.rca || {};

  const rcaEl = document.getElementById('tab-rca');
  if (rcaEl) rcaEl.innerHTML = `
    <div class="root-cause-box" style="margin-bottom:12px">
      <div class="rc-label">Root Cause Analysis
        <span style="font-size:10px;font-weight:400;margin-left:6px;color:var(--text4)">${rca.source === 'llm' ? '(LLM · ' + (rca.provider || '') + ')' : '(Deterministic)'}</span>
      </div>
      <div class="rc-title">${esc(rca.rootCause || 'Pending investigation')}</div>
      <div class="rc-desc">Confidence: ${rca.confidence || 0}%${rca.category ? ' · Category: ' + rca.category : ''}</div>
    </div>
    ${rca.reasoning ? `<div class="section-label" style="margin-bottom:4px">Reasoning</div>
    <div class="evidence-item" style="font-size:12px;line-height:1.6;margin-bottom:12px">${esc(rca.reasoning)}</div>` : ''}
    <div class="section-label" style="margin-bottom:4px">Evidence</div>
    <div class="evidence-list">
      ${(rca.evidence || []).map(e => `<div class="evidence-item" style="font-size:12px">• ${esc(e)}</div>`).join('')
        || '<div class="evidence-item">Click AI Investigate to gather evidence.</div>'}
    </div>
    ${rca.impactedServices?.length ? `
    <div class="section-label" style="margin-top:12px;margin-bottom:4px">Impacted Services</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${rca.impactedServices.map(s => `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--red)20;color:var(--red)">${esc(s)}</span>`).join('')}
    </div>` : ''}`;

  const postEl = document.getElementById('tab-postmortem');
  if (postEl) postEl.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <a class="btn-primary" href="/api/incidents/${data.incidentId}/postmortem.md" style="text-decoration:none;font-size:12px">⬇ Download Markdown</a>
    </div>
    <div class="postmortem-box">${esc(data.postmortem || 'No postmortem generated yet. Click AI Investigate to create one.')}</div>`;
}

function runAIInvestigation() {
  if (typeof activeModal === 'undefined' || !activeModal) return;
  const btn = document.getElementById('btn-investigate');
  if (btn) { btn.textContent = '⏳ Investigating…'; btn.disabled = true; }

  fetch('/api/incidents/' + activeModal + '/investigate', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (btn) { btn.textContent = '✓ Done'; btn.disabled = false; }
      if (!data || !data.rootCause) return;

      // Render RCA
      const rcaEl = document.getElementById('tab-rca');
      if (rcaEl) rcaEl.innerHTML = `
        <div class="root-cause-box" style="margin-bottom:12px">
          <div class="rc-label">AI Root Cause Analysis
            <span style="font-size:10px;font-weight:400;margin-left:6px;color:var(--text4)">${data.source === 'llm' ? '(LLM · ' + (data.provider || '') + ')' : '(Deterministic)'}</span>
          </div>
          <div class="rc-title">${esc(data.rootCause)}</div>
          <div class="rc-desc">Confidence: ${data.confidence || 0}%${data.category ? ' · ' + data.category : ''}</div>
        </div>
        ${data.reasoning ? `<div class="section-label" style="margin-bottom:4px">Reasoning</div>
        <div class="evidence-item" style="font-size:12px;line-height:1.6;margin-bottom:12px">${esc(data.reasoning)}</div>` : ''}
        <div class="section-label" style="margin-bottom:4px">Evidence</div>
        <div class="evidence-list">
          ${(data.evidence || []).map(e => `<div class="evidence-item" style="font-size:12px">• ${esc(e)}</div>`).join('')}
        </div>
        ${data.impactedServices?.length ? `
        <div class="section-label" style="margin-top:12px;margin-bottom:4px">Impacted Services</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${data.impactedServices.map(s => `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--red)20;color:var(--red)">${esc(s)}</span>`).join('')}
        </div>` : ''}
        ${data.hypotheses?.length ? `
        <div class="section-label" style="margin-top:12px;margin-bottom:4px">All Hypotheses</div>
        <div class="evidence-list">
          ${data.hypotheses.map((h, i) => `
          <div class="evidence-item" style="padding:8px 10px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
              <span style="font-size:11px;font-weight:600;color:var(--text4)">${i+1}. ${esc(h.category)}</span>
              <div style="width:50px;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden">
                <div style="width:${Math.round((h.confidence||0)*100)}%;height:100%;background:var(--blue)"></div>
              </div>
              <span style="font-size:11px;color:var(--text4)">${Math.round((h.confidence||0)*100)}%</span>
            </div>
            <div style="font-size:12px;color:var(--text2)">${esc(h.hypothesis)}</div>
          </div>`).join('')}
        </div>` : ''}`;

      if (data.similar) renderSimilarTab(data.similar);
      if (data.correlationGraph) renderCorrelationTab(data.correlationGraph);
    })
    .catch(() => {
      if (btn) { btn.textContent = '🤖 AI Investigate'; btn.disabled = false; }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADVANCED ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════

function fetchAdvancedAnalytics() {
  fetch('/api/analytics/advanced?hours=24').then(r => r.json()).then(data => {
    const el = document.getElementById('advanced-analytics');
    if (!el) return;
    const pct = (v, t) => t ? Math.round(v / t * 100) : 0;
    el.innerHTML = `
      <div class="analysis-grid" style="margin-bottom:14px">
        <div class="analysis-box"><div class="analysis-label">Total Incidents</div><div class="analysis-value" style="font-size:20px">${data.totalIncidents||0}</div></div>
        <div class="analysis-box"><div class="analysis-label">Recovery Rate</div><div class="analysis-value" style="font-size:20px;color:var(--green)">${data.recoverySuccessRate||0}%</div></div>
        <div class="analysis-box"><div class="analysis-label">MTTR</div><div class="analysis-value" style="font-size:20px">${data.mttrMinutes||0}m</div></div>
        <div class="analysis-box"><div class="analysis-label">Heal Actions</div><div class="analysis-value" style="font-size:20px">${data.totalHeals||0}</div></div>
      </div>
      ${data.rcaDistribution?.length ? `
      <div class="section-label" style="margin-bottom:6px">Root Cause Distribution</div>
      <div class="evidence-list" style="margin-bottom:12px">
        ${data.rcaDistribution.sort((a,b) => b.value - a.value).slice(0, 8).map(d => {
          const p = pct(d.value, data.totalIncidents);
          return `<div class="evidence-item" style="padding:6px 10px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:12px">${esc(d.label)}</span>
              <span style="font-size:11px;color:var(--text4)">${d.value} (${p}%)</span>
            </div>
            <div style="height:5px;background:var(--surface2);border-radius:3px;overflow:hidden">
              <div style="width:${p}%;height:100%;background:var(--blue-mid,#378ADD);border-radius:3px"></div>
            </div>
          </div>`;
        }).join('')}
      </div>` : ''}`;
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
//  SPLUNK HEALTH PAGE
// ═══════════════════════════════════════════════════════════════════════════

function fetchSplunkHealth() {
  const el = document.getElementById('splunk-health-content');
  if (el) el.innerHTML = '<div class="empty-state"><p>Checking…</p></div>';
  fetch('/api/splunk/health').then(r => r.json()).then(renderSplunkHealth).catch(err => {
    if (el) el.innerHTML = `<div class="empty-state"><p>Error: ${esc(err.message)}</p></div>`;
  });
}

function renderSplunkHealth(data) {
  const el = document.getElementById('splunk-health-content');
  if (!el) return;
  if (!data.enabled) {
    el.innerHTML = `
      <div class="empty-state">
        <div style="font-size:32px;margin-bottom:8px">🔌</div>
        <p style="font-weight:600">Splunk integration is disabled</p>
        <p style="font-size:12px;color:var(--text4);margin-top:10px;line-height:1.6">
          Enable it to get Splunk-powered evidence, richer correlation, and cross-incident search.<br><br>
          In <code>logpilot.config.js</code>:<br>
          <code style="font-size:11px;display:block;margin-top:6px;padding:8px;background:var(--surface2);border-radius:6px;text-align:left">
            splunk: {<br>
            &nbsp;&nbsp;enabled: true,<br>
            &nbsp;&nbsp;hecUrl: 'http://localhost:8088',<br>
            &nbsp;&nbsp;token: process.env.SPLUNK_HEC_TOKEN,<br>
            &nbsp;&nbsp;index: 'logpilot'<br>
            }
          </code>
          <br>See <strong>SPLUNK_SETUP.md</strong> for the Docker quickstart guide.
        </p>
      </div>`;
    return;
  }
  const hec  = data.hecHealth || {};
  const diag = data.startupDiagnostics || {};
  const ok   = data.hecStatus?.ok;
  const badge = (b, t) => `<span class="badge ${b?'badge-green':'badge-red'}" style="font-size:11px">${t}</span>`;
  const fmt   = ts => ts ? new Date(ts).toLocaleTimeString() : '—';

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <div style="font-size:24px">${ok ? '✅' : '❌'}</div>
      <div>
        <div style="font-weight:600;font-size:14px;color:${ok?'var(--green)':'var(--red)'}">${ok ? 'HEC Connected' : 'HEC Disconnected'}</div>
        <div style="font-size:11px;color:var(--text4)">${data.host}:8088 → index: ${esc(data.index)}</div>
      </div>
    </div>
    <div class="analysis-grid" style="margin-bottom:14px">
      <div class="analysis-box"><div class="analysis-label">Queue</div><div class="analysis-value" style="color:${(hec.queueSize||0)>500?'var(--red)':'inherit'}">${hec.queueSize||0}</div></div>
      <div class="analysis-box"><div class="analysis-label">DLQ</div><div class="analysis-value" style="color:${(hec.dlqSize||0)>0?'var(--yellow)':'inherit'}">${hec.dlqSize||0}</div></div>
      <div class="analysis-box"><div class="analysis-label">Dropped</div><div class="analysis-value" style="color:${(hec.droppedEvents||0)>0?'var(--red)':'inherit'}">${hec.droppedEvents||0}</div></div>
      <div class="analysis-box"><div class="analysis-label">Sent</div><div class="analysis-value">${hec.totalSent||0}</div></div>
      <div class="analysis-box"><div class="analysis-label">Failures</div><div class="analysis-value" style="color:${(hec.consecutiveFailures||0)>0?'var(--red)':'inherit'}">${hec.consecutiveFailures||0}</div></div>
      <div class="analysis-box"><div class="analysis-label">Schema</div><div class="analysis-value">v${esc(data.schemaVersion||'?')}</div></div>
    </div>
    <div class="evidence-list" style="margin-bottom:10px">
      <div class="evidence-item"><strong>Last success:</strong> ${fmt(hec.lastSuccessAt)}</div>
      <div class="evidence-item"><strong>Last flush:</strong> ${fmt(hec.lastFlushAt)}</div>
      ${hec.lastError ? `<div class="evidence-item" style="color:var(--red)"><strong>Last error:</strong> ${esc(hec.lastError)}</div>` : ''}
    </div>
    ${diag.hec ? `
    <div class="section-label" style="margin-bottom:6px">Startup diagnostics</div>
    <div class="evidence-list">
      <div class="evidence-item">HEC: ${badge(diag.hec.ok, diag.hec.ok ? 'OK' : 'FAILED')}
        ${diag.hec.latencyMs != null ? ` <span style="color:var(--text4);font-size:11px">${diag.hec.latencyMs}ms</span>` : ''}
        ${diag.hec.error ? ` <span style="color:var(--red);font-size:11px">${esc(diag.hec.error)}</span>` : ''}
      </div>
      <div class="evidence-item">Search API: ${badge(diag.search?.ok, diag.search?.ok ? 'OK' : 'Unavailable')}</div>
    </div>` : ''}
    <div style="margin-top:12px">
      <button class="btn-outline" style="font-size:12px" onclick="fetchSplunkHealth()">↻ Re-test connectivity</button>
    </div>`;
}

async function retestSplunkConnectivity() { fetchSplunkHealth(); }

// ═══════════════════════════════════════════════════════════════════════════
//  MLTK PREDICTIONS PAGE — Splunk Machine Learning Toolkit predictive searches
// ═══════════════════════════════════════════════════════════════════════════

const PREDICTION_META = {
  latencySpike: {
    label: 'Latency Spike Forecast',
    icon: '⚡',
    desc: 'Flags services whose response time is an outlier vs. its modeled distribution (DensityFunction).',
    color: '#EF9F27',
  },
  memoryExhaustion: {
    label: 'Memory Exhaustion Forecast',
    icon: '🧠',
    desc: 'Forecasts memory usage 24h ahead (StateSpaceForecast) and flags services projected above 90% upper bound.',
    color: '#E24B4A',
  },
  outageRisk: {
    label: 'Outage Risk Score',
    icon: '🚨',
    desc: 'Combines error rate, latency, memory, and recent incidents into a logistic regression outage-risk score.',
    color: '#7c3aed',
  },
};

function fetchPredictions() {
  const el = document.getElementById('predictions-list');
  if (!el) return;
  el.innerHTML = '<div class="empty-state"><p>Loading predictive searches…</p></div>';

  fetch('/api/commander/predictions').then(r => r.json()).then(data => {
    const queries = data.queries || {};
    const enabled = !!data.splunkEnabled;

    el.innerHTML = `
      ${!enabled ? `
        <div class="empty-state" style="margin-bottom:14px">
          <div style="font-size:28px;margin-bottom:6px">🔌</div>
          <p style="font-weight:600">Splunk is not enabled</p>
          <p style="font-size:12px;color:var(--text4);margin-top:6px">
            These predictive searches are generated below for reference, but require <code>splunk.enabled: true</code>
            and the MLTK app to actually run against live data.
          </p>
        </div>` : ''}
      <div class="grid2" style="gap:14px">
        ${Object.entries(queries).map(([name, spl]) => {
          const meta = PREDICTION_META[name] || { label: name, icon: '📊', desc: '', color: '#378ADD' };
          return `
          <div class="card">
            <div class="card-header">
              <div class="card-title">${meta.icon} ${esc(meta.label)}</div>
              <div class="card-action" onclick="runPrediction('${name}')" id="run-btn-${name}">▶ Run</div>
            </div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:8px;line-height:1.5">${esc(meta.desc)}</div>
            <details style="margin-bottom:8px">
              <summary style="font-size:11px;color:var(--text4);cursor:pointer">View SPL query</summary>
              <pre style="font-size:10px;white-space:pre-wrap;background:var(--surface2);padding:8px;border-radius:6px;margin-top:6px;border:1px solid var(--border);overflow:auto">${esc(spl)}</pre>
            </details>
            <div id="pred-out-${name}">
              <div class="empty-state" style="padding:14px 0"><p style="font-size:12px">Click "Run" to query Splunk MLTK${enabled ? '' : ' (disabled — will fall back to local evidence)'}.</p></div>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
  }).catch(err => {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--red)">Failed to load predictions: ${esc(err.message)}</p></div>`;
  });
}

function runPrediction(name) {
  const out = document.getElementById('pred-out-' + name);
  const btn = document.getElementById('run-btn-' + name);
  if (!out) return;
  if (btn) btn.textContent = '⏳ Running…';
  out.innerHTML = '<div class="empty-state" style="padding:14px 0"><p style="font-size:12px">Querying Splunk…</p></div>';

  fetch('/api/commander/predictions/run?name=' + encodeURIComponent(name)).then(r => r.json()).then(data => {
    if (btn) btn.textContent = '▶ Run';
    if (data.error) {
      out.innerHTML = `<div class="empty-state" style="padding:14px 0"><p style="font-size:12px;color:var(--red)">${esc(data.error)}: ${esc(data.message||'')}</p></div>`;
      return;
    }
    const events = data.events || [];
    const meta = PREDICTION_META[name] || { color: '#378ADD' };

    if (!events.length) {
      out.innerHTML = `
        <div class="empty-state" style="padding:14px 0">
          <p style="font-size:12px">No anomalies detected — source: ${esc(data.source||'local')}</p>
          <p style="font-size:11px;color:var(--text4);margin-top:4px">Either nothing is outside the model bounds right now, or there isn't enough history yet to fit the model.</p>
        </div>`;
      return;
    }

    out.innerHTML = `
      <div style="font-size:11px;color:var(--text4);margin-bottom:8px">${events.length} result(s) · source: ${esc(data.source||'local')}</div>
      ${renderPredictionChart(name, events, meta.color)}
      <div class="evidence-list" style="margin-top:8px">
        ${events.slice(0, 8).map(e => `
          <div class="evidence-item" style="padding:6px 10px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
            ${Object.entries(e).filter(([k]) => !k.startsWith('_')).slice(0, 6).map(([k, v]) =>
              `<span style="font-size:11px"><span style="color:var(--text4)">${esc(k)}:</span> ${esc(String(v))}</span>`
            ).join('')}
          </div>
        `).join('')}
      </div>
    `;
  }).catch(err => {
    if (btn) btn.textContent = '▶ Run';
    out.innerHTML = `<div class="empty-state" style="padding:14px 0"><p style="font-size:12px;color:var(--red)">${esc(err.message)}</p></div>`;
  });
}

// Renders a dynamic SVG bar chart from arbitrary numeric fields in the result rows
function renderPredictionChart(name, events, color) {
  // pick the first numeric field (excluding internal/time fields) across rows as the chart value
  const sample = events[0] || {};
  const numericKey = Object.keys(sample).find(k => {
    if (k.startsWith('_') || /time|service|path|host/i.test(k)) return false;
    const v = Number(sample[k]);
    return !Number.isNaN(v);
  });
  if (!numericKey) return '';

  const vals = events.map(e => Number(e[numericKey]) || 0);
  const labels = events.map(e => e.service || e.path || e._time || '');
  const max = Math.max(...vals, 1);
  const W = 100, H = 60;
  const barW = Math.max(4, Math.floor(W / vals.length) - 2);

  const bars = vals.map((v, i) => {
    const h = Math.max(2, Math.round((v / max) * (H - 4)));
    const x = i * (barW + 2);
    return `<rect x="${x}" y="${H - h}" width="${barW}" height="${h}" fill="${color}" rx="1">
      <title>${esc(String(labels[i]))}: ${esc(String(v))}</title>
    </rect>`;
  }).join('');

  return `
    <div style="margin-top:4px">
      <div style="font-size:10px;color:var(--text4);margin-bottom:4px">${esc(numericKey)} by ${labels[0] ? 'service/path' : 'result'}</div>
      <svg width="100%" height="60" viewBox="0 0 ${vals.length * (barW + 2)} ${H}" preserveAspectRatio="none" style="display:block">${bars}</svg>
    </div>
  `;
}
