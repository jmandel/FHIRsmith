// @ts-check

const { monitorEventLoopDelay } = require('perf_hooks');
const {Utilities} = require("./library/utilities");
const escape = require('escape-html');

/** @typedef {{idle: number, total: number}} CpuUsage */
/** @typedef {{time: number, mem: number, rpm: number, tat: number, cpu: number, block: number, cache: number}} MetricSnapshot */
/** @typedef {{cacheCount: () => number}} CachingModule */
/** @typedef {{frequency?: string, state?: string, status?: string, date?: number}} TaskInfo */

class ServerStats {
  /** @type {boolean} */
  started = false;
  /** @type {number} */
  requestCount = 0;
  /** @type {number} */
  staticRequestCount = 0;
  /** @type {number} */
  requestTime = 0;
  // Collect metrics every 10 minutes
  /** @type {number} */
  intervalMs = 10 * 60 * 1000;
  /** @type {MetricSnapshot[]} */
  history = [];
  /** @type {number} */
  requestCountSnapshot = 0;
  /** @type {number} */
  startMem = 0;
  /** @type {number} */
  startTime = Date.now();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  timer;
  /** @type {CachingModule[]} */
  cachingModules = [];
  /** @type {Map<string, TaskInfo>} */
  taskMap = new Map();
  /** @type {CpuUsage} */
  lastUsage = {idle: 0, total: 0};
  /** @type {number} */
  lastTime = 0;
  /** @type {ReturnType<typeof monitorEventLoopDelay> | null} */
  eventLoopMonitor = null;

  constructor() {
    this.timer = setInterval(() => {
      this.recordMetrics();
    }, this.intervalMs);
  }

  recordMetrics() {
    if (this.started) {
      const now = Date.now();

      const currentMem = process.memoryUsage().heapUsed;
      const combinedCount = this.requestCount + this.staticRequestCount;
      const requestsDelta = combinedCount - this.requestCountSnapshot;
      const requestsTat = requestsDelta > 0 ? this.requestTime / requestsDelta : 0;
      const minutesSinceStart = this.history.length > 1
        ? this.intervalMs / 60000
        : (now - this.startTime) / 60000;
      const requestsPerMin = minutesSinceStart > 0 ? requestsDelta / minutesSinceStart : 0;

      const currentCpu = this.readSystemCpu();
      const idleDelta = currentCpu.idle - this.lastUsage.idle;
      const totalDelta = currentCpu.total - this.lastUsage.total;
      const percent = totalDelta > 0 ? 100 * (1 - idleDelta / totalDelta) : 0;

      const loopDelay = this.eventLoopMonitor ? this.eventLoopMonitor.mean / 1e6 : 0;
      let cacheCount = 0;
      for (const m of this.cachingModules) {
        cacheCount = cacheCount + m.cacheCount();
      }

      this.history.push({time: now, mem: currentMem - this.startMem, rpm: requestsPerMin, tat: requestsTat, cpu: percent, block: loopDelay, cache : cacheCount});

      if (this.eventLoopMonitor) {
        this.eventLoopMonitor.reset();
      }
      this.requestCountSnapshot = combinedCount;
      this.requestTime = 0;
      this.lastTime = now;
      this.lastUsage = currentCpu;

      // Prune old data (keep 24 hours)
      const cutoff = now - (24 * 60 * 60 * 1000); // 24 hours ago
      this.history = this.history.filter(m => m.time > cutoff);
    }
  }

  markStarted() {
    this.started = true;
    this.startMem = process.memoryUsage().heapUsed;
    this.startTime = Date.now();
    this.lastUsage = this.readSystemCpu();
    this.lastTime = this.startTime;
    this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopMonitor.enable();
    this.recordMetrics();
  }

  /**
   * @param {string} name
   * @param {number} tat
   */
  countRequest(name, tat) {
    // we ignore name for now, but we might split the tat tracking up by name
    // at some stage
    this.requestCount++;
    this.requestTime = this.requestTime + tat;
  }

  /**
   * @param {string} name
   * @param {string} frequency
   */
  addTask(name, frequency) {
    /** @type {TaskInfo} */
    const info = {};
    this.taskMap.set(name, info);
    info.frequency = frequency;
    info.state = "Started";
    info.status = "started"
  }

  /**
   * @param {string} name
   * @param {string} state
   */
  task(name, state) {
    const info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'working';
    }
  }

  /**
   * @param {string} name
   * @param {string} state
   */
  taskDone(name, state) {
    const info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'resting';
    }
  }

  /**
   * @param {string} name
   * @param {string} state
   */
  taskError(name, state) {
    const info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'error';
    }
  }

  taskDetails() {
    if (this.taskMap.size === 0) {
      return "";
    }
    let html = '<table class="grid" >';
    html += "<tr><th>Background Task</th><th>Status</th><th>Frequency</th><th>Last Seen</th></tr>";
    for (const m of this.taskMap.keys()) {
      const mm = this.taskMap.get(m);
      if (!mm) {
        continue;
      }
      const color = this.getTaskColor(mm.status || '');
      html += `<tr style="background-color: ${color}"><td>`;
      html += escape(m);
      html += "</td><td>";
      html += escape(mm.state || '');
      html += "</td><td>";
      html += mm.frequency || '';
      html += "</td><td>";
      html += Utilities.formatDuration(mm.date || Date.now(), Date.now());
      html += "</td></tr>";
    }
    html += "</table>";
    return html;
  }

  finishStats() {
    clearInterval(this.timer);
  }

  /**
   * @returns {CpuUsage}
   */
  readSystemCpu() {
    const os = require('os');
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    return { idle, total };
  }

  /**
   * @param {string} status
   * @returns {string}
   */
  getTaskColor(status) {
    switch (status) {
      case "started": return "LightGrey";
      case "working": return "LightGreen";
      case "resting": return "White";
      case "error": return "LightRed";
      default: return "DarkBlue"; // should not happen
    }
  }
}
module.exports = ServerStats;
