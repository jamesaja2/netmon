export default {
  async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);
    const tzOptions = { timeZone: 'Asia/Jakarta', hour12: false };
    
    // 1. Ambil database dari Cloudflare KV
    let data = await env.WIFI_KV.get("monitor_data", { type: "json" });
    if (!data) {
      data = {
        last_seen: Math.floor(Date.now() / 1000),
        current_status: "ONLINE", // ONLINE, LEMOT, atau OFFLINE
        last_latency: 0,
        history: [],
        incidents: []
      };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = new Date().toLocaleTimeString('id-ID', tzOptions);
    const dateString = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });

    // -------------------------------------------------------------
    // JALUR 1: MIKROTIK KETOK PING BIASA (?ping=1&ms=X)
    // -------------------------------------------------------------
    if (searchParams.has('ping') && !searchParams.has('status')) {
      data.last_seen = nowSeconds;
      const latency = searchParams.get('ms') ? parseInt(searchParams.get('ms')) : 0;
      data.last_latency = latency;

      // Logika Deteksi Lemot Otomatis (Ping > 150ms) saat status awal ONLINE
      if (latency > 150 && data.current_status === 'ONLINE') {
        data.current_status = 'LEMOT';
        
        // Catat insiden Lemot baru ke database (TANPA DIHAPUS)
        data.incidents.unshift({
          date: dateString,
          down_time: timestamp,
          up_time: '-',
          duration: `Ping melonjak tinggi (${latency} ms)`,
          status_log: 'LEMOT',
          start_ts: nowSeconds
        });
      } 
      // Logika Pemulihan dari LEMOT kembali ke ONLINE biasa
      else if (latency <= 150 && latency > 0 && data.current_status === 'LEMOT') {
        data.current_status = 'ONLINE';
        
        if (data.incidents.length > 0 && data.incidents[0].status_log === 'LEMOT' && data.incidents[0].up_time === '-') {
          const lemotDuration = nowSeconds - data.incidents[0].start_ts;
          data.incidents[0].up_time = timestamp;
          data.incidents[0].duration = `Lemot selama ${lemotDuration} detik (Kembali ke ${latency} ms)`;
          data.incidents[0].status_log = 'RESOLVED';
        }
      }

      // Update data aliran grafik di memori
      if (data.current_status !== 'OFFLINE') {
        const graphStatus = data.current_status === 'LEMOT' ? 0.5 : 1;
        data.history.push({ time: timestamp, status: graphStatus, latency: latency });
        if (data.history.length > 30) data.history.shift();
      }

      await env.WIFI_KV.put("monitor_data", JSON.stringify(data));
      return new Response("PING_OK");
    }

    // -------------------------------------------------------------
    // JALUR 2: EVENT NETWATCH DARI MIKROTIK (?status=DOWN atau UP)
    // -------------------------------------------------------------
    if (searchParams.has('status')) {
      const reportedStatus = searchParams.get('status').toUpperCase();
      const latency = searchParams.get('ms') ? parseInt(searchParams.get('ms')) : 0;
      data.last_latency = latency;

      if (reportedStatus === 'DOWN' && data.current_status !== 'OFFLINE') {
        // Jika sebelumnya sedang berstatus LEMOT, selesaikan dulu log lemotnya
        if (data.current_status === 'LEMOT' && data.incidents.length > 0 && data.incidents[0].up_time === '-') {
          data.incidents[0].up_time = timestamp;
          data.incidents[0].duration = `Berubah dari Lemot menjadi MATI TOTAL`;
          data.incidents[0].status_log = 'RESOLVED';
        }

        data.current_status = 'OFFLINE';
        data.last_seen = nowSeconds;
        data.history.push({ time: timestamp, status: 0, latency: latency });
        if (data.history.length > 30) data.history.shift();

        data.incidents.unshift({
          date: dateString,
          down_time: timestamp,
          up_time: '-',
          duration: 'Mengalami Down / Putus',
          status_log: 'DOWN',
          start_ts: nowSeconds
        });

        await env.WIFI_KV.put("monitor_data", JSON.stringify(data));
        return new Response("STATUS_DOWN_RECORDED");
      } 
      
      if (reportedStatus === 'UP' && data.current_status === 'OFFLINE') {
        data.current_status = latency > 150 ? 'LEMOT' : 'ONLINE';
        data.history.push({ time: timestamp, status: latency > 150 ? 0.5 : 1, latency: latency });
        if (data.history.length > 30) data.history.shift();

        if (data.incidents.length > 0 && data.incidents[0].status_log === 'DOWN' && data.incidents[0].up_time === '-') {
          const downtimeSeconds = nowSeconds - data.incidents[0].start_ts;
          data.incidents[0].up_time = timestamp;
          data.incidents[0].duration = `${downtimeSeconds} detik (Pulih ke ${latency} ms)`;
          data.incidents[0].status_log = 'RESOLVED';
        }

        // Jika pulihnya langsung dalam keadaan LEMOT, buka log lemot baru
        if (data.current_status === 'LEMOT') {
          data.incidents.unshift({
            date: dateString,
            down_time: timestamp,
            up_time: '-',
            duration: `Pulih dari down tapi langsung LEMOT (${latency} ms)`,
            status_log: 'LEMOT',
            start_ts: nowSeconds
          });
        }

        data.last_seen = nowSeconds;
        await env.WIFI_KV.put("monitor_data", JSON.stringify(data));
        return new Response("STATUS_UP_RECORDED");
      }

      return new Response("NO_CHANGES");
    }

    // -------------------------------------------------------------
    // JALUR 3: RENDERING INTERFACE DASHBOARD WEB
    // -------------------------------------------------------------
    const timeDiffPage = nowSeconds - data.last_seen;
    const threshold = 20;

    // Fallback System jika router mati listrik total mendadak
    if (timeDiffPage > threshold && data.current_status !== 'OFFLINE') {
      data.current_status = 'OFFLINE';
      data.history.push({ time: timestamp, status: 0, latency: 0 });
      if (data.history.length > 30) data.history.shift();

      data.incidents.unshift({
        date: dateString,
        down_time: timestamp,
        up_time: 'N/A',
        duration: 'Mati Total / Listrik Padam',
        status_log: 'DOWN',
        start_ts: data.last_seen
      });
      await env.WIFI_KV.put("monitor_data", JSON.stringify(data));
    }

    const isOnline = (timeDiffPage <= threshold);
    const totalMati = data.incidents.filter(i => i.status_log === 'RESOLVED' && i.duration.includes('detik')).length;
    const totalLemot = data.incidents.filter(i => i.duration.includes('Lemot') || i.duration.includes('melonjak')).length;

    let statusText = "ONLINE & LANCAR";
    let statusClass = "bg-emerald-950 text-emerald-400 border-emerald-700 animate-pulse";
    
    if (data.current_status === 'OFFLINE' || !isOnline) {
      statusText = "OFFLINE / DOWN";
      statusClass = "bg-rose-950 text-rose-400 border-rose-700";
    } else if (data.current_status === 'LEMOT' || data.last_latency > 150) {
      statusText = "LEMOT / HIGH LATENCY";
      statusClass = "bg-amber-950 text-amber-400 border-amber-700 animate-pulse";
    }

    const chartLabels = data.history.map(h => h.time);
    const chartData = data.history.map(h => h.status);
    const chartLatency = data.history.map(h => h.latency);

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>⚡ Cloudflare Edge Wi-Fi Monitor</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 min-h-screen p-4 md:p-8 font-sans">
        <div class="max-w-4xl mx-auto">
            <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
                <div>
                    <h1 class="text-2xl font-bold tracking-tight text-white">📡 Wi-Fi Edge Status Page</h1>
                    <p class="text-sm text-slate-400 mt-1">Serverless Monitor dengan Deteksi Lemot & Putus Jaringan.</p>
                </div>
                <div class="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start w-full sm:w-auto gap-2">
                    <div class="flex gap-2">
                        <div class="bg-slate-900/60 px-3 py-1 rounded-lg border border-slate-700 text-xs text-slate-300">Live Ping: <span class="font-bold text-sky-400 text-sm">${data.last_latency} ms</span></div>
                        <div class="bg-slate-900/60 px-3 py-1 rounded-lg border border-slate-700 text-xs text-slate-300">Total Isu: <span class="font-bold text-rose-400 text-sm">${data.incidents.length}x</span></div>
                    </div>
                    <span class="inline-flex items-center px-4 py-1.5 ${statusClass} rounded-full text-sm font-bold border"><span class="w-2 h-2 rounded-full bg-current mr-2"></span> ${statusText}</span>
                </div>
            </header>

            <div class="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg mb-6">
                <h3 class="text-lg font-semibold mb-4 text-slate-300">📊 Grafik Latensi & Riwayat Jaringan</h3>
                <div class="h-64 w-full"><canvas id="uptimeChart"></canvas></div>
            </div>

            <div class="bg-slate-800 rounded-xl border border-slate-700 shadow-lg p-6 mb-6">
                <h3 class="text-lg font-semibold mb-4 text-slate-300">⚠️ Riwayat Masalah Jaringan Permanen (Mati & Lemot)</h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm text-slate-300 border-collapse">
                        <thead>
                            <tr class="border-b border-slate-700 text-slate-400 text-xs uppercase bg-slate-900/50">
                                <th class="py-3 px-4">Tanggal</th>
                                <th class="py-3 px-4">Mulai Kendala</th>
                                <th class="py-3 px-4">Jam Normal (Up)</th>
                                <th class="py-3 px-4">Keterangan / Durasi</th>
                                <th class="py-3 px-4 text-center">Tipe Log</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-700/50">
                            ${data.incidents.length === 0 ? `<tr><td colspan="5" class="py-8 text-center text-slate-500 font-medium">✨ Wi-Fi lancar jaya, belum ada log masalah terdeteksi.</td></tr>` : 
                              data.incidents.map(inc => `
                                <tr class="hover:bg-slate-750/30 transition">
                                    <td class="py-3.5 px-4 font-medium text-slate-400">${inc.date}</td>
                                    <td class="py-3.5 px-4 font-mono ${inc.status_log === 'DOWN' ? 'text-rose-400' : 'text-amber-400'}">${inc.down_time}</td>
                                    <td class="py-3.5 px-4 font-mono text-emerald-400">${inc.up_time}</td>
                                    <td class="py-3.5 px-4 text-slate-200 font-medium">${inc.duration}</td>
                                    <td class="py-3.5 px-4 text-center">
                                        <span class="px-2 py-0.5 rounded text-xs font-bold 
                                            ${inc.status_log === 'DOWN' ? 'bg-rose-950 text-rose-400 border border-rose-800 animate-pulse' : ''}
                                            ${inc.status_log === 'LEMOT' ? 'bg-amber-950 text-amber-400 border border-amber-800 animate-pulse' : ''}
                                            ${inc.status_log === 'RESOLVED' ? 'bg-slate-700 text-slate-300' : ''}
                                        ">${inc.status_log}</span>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
            <footer class="text-center text-xs text-slate-500">Terakhir Sinkronisasi Router: ${new Date(data.last_seen * 1000).toLocaleTimeString('id-ID', tzOptions)}</footer>
        </div>

        <script>
            const uptimeChart = new Chart(document.getElementById('uptimeChart').getContext('2d'), {
                type: 'line',
                data: {
                    labels: ${JSON.stringify(chartLabels)},
                    datasets: [
                        { label: 'Latensi (ms)', data: ${JSON.stringify(chartLatency)}, borderColor: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.05)', borderWidth: 2, yAxisID: 'y1', fill: true },
                        { label: 'Status Saklar', data: ${JSON.stringify(chartData)}, borderColor: '#10b981', borderWidth: 1.5, pointRadius: 0, stepped: true, yAxisID: 'y', borderDash: [5, 5] }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    scales: {
                        y: { min: 0, max: 1, ticks: { stepSize: 0.5, callback: v => v === 1 ? 'ONLINE' : (v === 0.5 ? 'LEMOT' : 'DOWN'), color: '#10b981' }, grid: { color: '#334155' } },
                        y1: { position: 'right', min: 0, suggestedMax: 150, ticks: { callback: v => v + ' ms', color: '#38bdf8' }, grid: { drawOnChartArea: false } },
                        x: { ticks: { color: '#94a3b8', font: { size: 10 } } }
                    }
                }
            });
            setTimeout(() => { location.reload(); }, 5000);
        </script>
    </body>
    </html>`;

    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
};
