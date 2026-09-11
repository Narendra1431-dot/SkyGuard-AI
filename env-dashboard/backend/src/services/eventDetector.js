'use strict';

const { randomUUID } = require('crypto');
const { classifyChange } = require('./stateSnapshot');

const SEVERITY = { INFO: 'INFO', WARNING: 'WARNING', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
const CATEGORY = {
  ENVIRONMENTAL: 'environmental',
  STATION: 'station',
  PROVIDER: 'provider',
  QUALITY: 'quality',
  ANOMALY: 'anomaly',
  ALT: 'alert',
  INGESTION: 'ingestion',
  ML: 'ml',
  RAG: 'rag',
  CORRELATION: 'correlation',
  MAINTENANCE: 'maintenance',
  SYSTEM: 'system',
  FLEET: 'fleet',
};

const EVENT_RULES = [
  {
    name: 'critical_aqi_crossing',
    test: (snapshot) => snapshot.stations.some((s) => s.reading && s.reading.aqi > 250),
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.ENVIRONMENTAL,
    title: 'Critical AQI threshold crossed',
    evaluate: (snapshot) => {
      const stations = snapshot.stations.filter((s) => s.reading && s.reading.aqi > 250);
      return { stations: stations.map((s) => ({ id: s.id, name: s.name, aqi: s.reading.aqi })), count: stations.length };
    },
  },
  {
    name: 'critical_temperature_crossing',
    test: (snapshot) => snapshot.stations.some((s) => s.reading && s.reading.temperature > 42),
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.ENVIRONMENTAL,
    title: 'Critical temperature threshold crossed',
    evaluate: (snapshot) => {
      const stations = snapshot.stations.filter((s) => s.reading && s.reading.temperature > 42);
      return { stations: stations.map((s) => ({ id: s.id, name: s.name, temperature: s.reading.temperature })), count: stations.length };
    },
  },
  {
    name: 'critical_humidity_low',
    test: (snapshot) => snapshot.stations.some((s) => s.reading && s.reading.humidity < 15),
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.ENVIRONMENTAL,
    title: 'Critical humidity threshold crossed (dangerously low)',
    evaluate: (snapshot) => {
      const stations = snapshot.stations.filter((s) => s.reading && s.reading.humidity < 15);
      return { stations: stations.map((s) => ({ id: s.id, name: s.name, humidity: s.reading.humidity })), count: stations.length };
    },
  },
  {
    name: 'station_offline',
    test: (snapshot) => snapshot.stations.some((s) => s.status === 'OFFLINE'),
    severity: SEVERITY.HIGH,
    category: CATEGORY.STATION,
    title: 'Station went offline',
    evaluate: (snapshot) => {
      const offline = snapshot.stations.filter((s) => s.status === 'OFFLINE');
      return { stations: offline.map((s) => ({ id: s.id, name: s.name })), count: offline.length };
    },
  },
  {
    name: 'station_rapid_degradation',
    test: (snapshot) => {
      const stations = snapshot.stations.filter((s) => s.healthScore < 50 && s.status !== 'OFFLINE');
      if (stations.length === 0) return false;
      const prevHealth = stations.find((s) => s.prevHealthScore && s.prevHealthScore - s.healthScore > 30);
      return stations.length >= 1 || !!prevHealth;
    },
    severity: SEVERITY.HIGH,
    category: CATEGORY.STATION,
    title: 'Station health rapidly degraded',
    evaluate: (snapshot) => {
      const degraded = snapshot.stations.filter((s) => s.healthScore < 50 && s.status !== 'OFFLINE');
      return { stations: degraded.map((s) => ({ id: s.id, name: s.name, healthScore: s.healthScore })), count: degraded.length };
    },
  },
  {
    name: 'provider_failed',
    test: (snapshot) => snapshot.providers.some((p) => p.status === 'RED'),
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.PROVIDER,
    title: 'Provider failed',
    evaluate: (snapshot) => {
      const failed = snapshot.providers.filter((p) => p.status === 'RED');
      return { providers: failed.map((p) => ({ id: p.id, name: p.name, lastError: p.lastError })), count: failed.length };
    },
  },
  {
    name: 'provider_degraded',
    test: (snapshot) => snapshot.providers.some((p) => p.status === 'YELLOW'),
    severity: SEVERITY.WARNING,
    category: CATEGORY.PROVIDER,
    title: 'Provider degraded',
    evaluate: (snapshot) => {
      const degraded = snapshot.providers.filter((p) => p.status === 'YELLOW');
      return { providers: degraded.map((p) => ({ id: p.id, name: p.name })), count: degraded.length };
    },
  },
  {
    name: 'data_quality_degraded',
    test: (snapshot) => snapshot.dataQuality.status === 'RED' || snapshot.dataQuality.overallScore < 60,
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.QUALITY,
    title: 'Data quality severely degraded',
    evaluate: (snapshot) => ({
      overallScore: snapshot.dataQuality.overallScore,
      completeness: snapshot.dataQuality.completeness,
      validity: snapshot.dataQuality.validity,
      freshnessSeconds: snapshot.dataQuality.freshnessSeconds,
    }),
  },
  {
    name: 'data_quality_warning',
    test: (snapshot) => snapshot.dataQuality.status === 'YELLOW' || (snapshot.dataQuality.overallScore >= 60 && snapshot.dataQuality.overallScore < 80),
    severity: SEVERITY.WARNING,
    category: CATEGORY.QUALITY,
    title: 'Data quality warning',
    evaluate: (snapshot) => ({
      overallScore: snapshot.dataQuality.overallScore,
      completeness: snapshot.dataQuality.completeness,
      validity: snapshot.dataQuality.validity,
    }),
  },
  {
    name: 'anomaly_count_high',
    test: (snapshot) => snapshot.anomalies.count > 5,
    severity: SEVERITY.HIGH,
    category: CATEGORY.ANOMALY,
    title: 'High anomaly count detected',
    evaluate: (snapshot) => ({
      totalAnomalies: snapshot.anomalies.count,
      criticalCount: snapshot.anomalies.critical,
      warningCount: snapshot.anomalies.warning,
      byStation: snapshot.anomalies.byStation,
    }),
  },
  {
    name: 'critical_anomalies_present',
    test: (snapshot) => snapshot.anomalies.critical > 0,
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.ANOMALY,
    title: 'Critical anomalies detected',
    evaluate: (snapshot) => ({
      criticalCount: snapshot.anomalies.critical,
      totalAnomalies: snapshot.anomalies.count,
      byStation: snapshot.anomalies.byStation,
    }),
  },
  {
    name: 'maintenance_risk_high',
    test: (snapshot) => snapshot.maintenance.status === 'RED' || snapshot.maintenance.highRiskCount > 0,
    severity: SEVERITY.HIGH,
    category: CATEGORY.MAINTENANCE,
    title: 'High maintenance risk detected',
    evaluate: (snapshot) => ({
      highRiskCount: snapshot.maintenance.highRiskCount,
      items: snapshot.maintenance.items.filter((i) => i.riskScore > 70),
    }),
  },
  {
    name: 'alert_critical_open',
    test: (snapshot) => snapshot.alerts.critical > 0,
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.ALT,
    title: 'Critical alert open',
    evaluate: (snapshot) => ({
      criticalAlerts: snapshot.alerts.critical,
      totalOpen: snapshot.alerts.open,
    }),
  },
  {
    name: 'alert_warning_open',
    test: (snapshot) => snapshot.alerts.warning > 0,
    severity: SEVERITY.HIGH,
    category: CATEGORY.ALT,
    title: 'Warning alerts open',
    evaluate: (snapshot) => ({
      warningAlerts: snapshot.alerts.warning,
      totalOpen: snapshot.alerts.open,
    }),
  },
  {
    name: 'ingestion_stale',
    test: (snapshot) => snapshot.ingestion.status === 'YELLOW' || snapshot.ingestion.status === 'RED',
    severity: SEVERITY.WARNING,
    category: CATEGORY.INGESTION,
    title: 'Ingestion freshness degraded',
    evaluate: (snapshot) => ({
      ageSeconds: snapshot.ingestion.ageSeconds,
      freshness: snapshot.ingestion.freshness,
      status: snapshot.ingestion.status,
    }),
  },
  {
    name: 'ingestion_stopped',
    test: (snapshot) => snapshot.ingestion.ageSeconds != null && snapshot.ingestion.ageSeconds > 120,
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.INGESTION,
    title: 'Ingestion stopped - no recent readings',
    evaluate: (snapshot) => ({
      ageSeconds: snapshot.ingestion.ageSeconds,
      lastTickAt: snapshot.ingestion.lastTickAt,
    }),
  },
  {
    name: 'ml_drift_detected',
    test: (snapshot) => snapshot.ml && snapshot.ml.drift && snapshot.ml.drift.score > 10,
    severity: SEVERITY.WARNING,
    category: CATEGORY.ML,
    title: 'ML model drift detected',
    evaluate: (snapshot) => ({
      driftScore: snapshot.ml.drift?.score,
      modelType: snapshot.ml.modelType,
      perField: snapshot.ml.drift?.perField || [],
    }),
  },
  {
    name: 'rag_unavailable',
    test: (snapshot) => snapshot.rag && (snapshot.rag.status === 'RED' || snapshot.rag.ready === 0),
    severity: SEVERITY.HIGH,
    category: CATEGORY.RAG,
    title: 'RAG knowledge system unavailable',
    evaluate: (snapshot) => ({ status: snapshot.rag.status, documents: snapshot.rag.documents, ready: snapshot.rag.ready }),
  },
  {
    name: 'rag_zero_chunks',
    test: (snapshot) => snapshot.rag && snapshot.rag.chunks === 0,
    severity: SEVERITY.INFO,
    category: CATEGORY.RAG,
    title: 'RAG has no indexed content',
    evaluate: (snapshot) => ({ documents: snapshot.rag.documents, chunks: 0 }),
  },
  {
    name: 'multiple_related_anomalies',
    test: (snapshot) => {
      const anomalousStations = snapshot.stations.filter((s) => s.reading && s.reading.anomaly === 1);
      return anomalousStations.length >= 3;
    },
    severity: SEVERITY.HIGH,
    category: CATEGORY.CORRELATION,
    title: 'Multiple related anomalies detected across stations',
    evaluate: (snapshot) => ({
      anomalousStations: snapshot.stations.filter((s) => s.reading && s.reading.anomaly === 1).map((s) => ({ id: s.id, name: s.name, aqi: s.reading?.aqi })),
      count: snapshot.stations.filter((s) => s.reading && s.reading.anomaly === 1).length,
    }),
  },
  {
    name: 'correlated_anomaly_cluster',
    test: (snapshot) => {
      const anomaliesByStation = snapshot.stations.filter((s) => s.reading && s.reading.anomaly === 1);
      if (anomaliesByStation.length < 2) return false;
      const avgAqi = anomaliesByStation.reduce((sum, s) => sum + (s.reading?.aqi || 0), 0) / anomaliesByStation.length;
      const variance = anomaliesByStation.reduce((sum, s) => sum + ((s.reading?.aqi || 0) - avgAqi) ** 2, 0) / anomaliesByStation.length;
      const deviation = Math.sqrt(variance);
      return deviation < 50;
    },
    severity: SEVERITY.HIGH,
    category: CATEGORY.CORRELATION,
    title: 'Correlated anomaly cluster detected',
    evaluate: (snapshot) => {
      const stations = snapshot.stations.filter((s) => s.reading && s.reading.anomaly === 1);
      const aqis = stations.map((s) => s.reading?.aqi || 0);
      const minAqi = Math.min(...aqis);
      const maxAqi = Math.max(...aqis);
      return {
        stations: stations.map((s) => ({ id: s.id, name: s.name, aqi: s.reading?.aqi })),
        count: stations.length,
        aqiSpread: maxAqi - minAqi,
        correlation: ((maxAqi - minAqi) < 50) ? 'HIGH' : 'MODERATE',
      };
    },
  },
  {
    name: 'spatial_anomaly_isolation',
    test: (snapshot) => {
      const criticalStations = snapshot.stations.filter((s) => s.reading && (s.reading.aqi > 250 || s.reading.temperature > 42));
      if (criticalStations.length !== 1) return false;
      const allStationReadings = snapshot.stations.map((s) => s.reading).filter(Boolean);
      const otherAqi = allStationReadings.filter((r) => r.stationId !== criticalStations[0].id).map((r) => r.aqi);
      if (otherAqi.length === 0) return false;
      const avgOtherAqi = otherAqi.reduce((s, v) => s + v, 0) / otherAqi.length;
      return criticalStations[0].reading.aqi > avgOtherAqi * 2;
    },
    severity: SEVERITY.CRITICAL,
    category: CATEGORY.CORRELATION,
    title: 'Spatially isolated critical anomaly',
    evaluate: (snapshot) => {
      const critical = snapshot.stations.filter((s) => s.reading && (s.reading.aqi > 250 || s.reading.temperature > 42));
      return {
        isolatedStation: critical[0]?.id,
        aqi: critical[0]?.reading?.aqi,
        reason: 'Other stations within normal range',
      };
    },
  },
];

function detectEvents(snapshot, prevSnapshot) {
  const events = [];
  for (const rule of EVENT_RULES) {
    try {
      if (rule.test(snapshot)) {
        const detail = rule.evaluate(snapshot);
        const isRecovery = prevSnapshot && !rule.test(prevSnapshot);
        const event = {
          id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
          type: `MONITOR.${rule.name}`,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          summary: JSON.stringify(detail).slice(0, 500),
          evidence: detail,
          timestamp: snapshot.timestamp,
          snapshotId: snapshot.id,
          isRecovery: isRecovery && rule.severity === SEVERITY.INFO,
          correlationId: `${snapshot.timestamp}-${rule.name}`,
        };
        events.push(event);
      }
    } catch (_) { }
  }
  if (prevSnapshot) {
    const recoveryEvents = detectRecoveries(prevSnapshot, snapshot);
    events.push(...recoveryEvents);
  }
  return events;
}

function detectRecoveries(prev, curr) {
  const recoveries = [];
  const prevFailedProviders = prev.providers.filter((p) => p.status === 'RED');
  const currGreenProviders = curr.providers.filter((p) => p.status === 'GREEN');
  for (const p of currGreenProviders) {
    if (prevFailedProviders.some((fp) => fp.id === p.id)) {
      recoveries.push({
        id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
        type: 'MONITOR.provider.recovered',
        category: CATEGORY.PROVIDER,
        severity: SEVERITY.INFO,
        title: `Provider ${p.name} recovered`,
        summary: `Provider ${p.name} returned to GREEN after being RED`,
        evidence: { providerId: p.id, name: p.name, previousError: p.lastError },
        timestamp: curr.timestamp,
        snapshotId: curr.id,
        isRecovery: true,
      });
    }
  }
  const prevOffline = prev.stations.filter((s) => s.status === 'OFFLINE');
  const currOnline = curr.stations.filter((s) => s.status !== 'OFFLINE');
  for (const s of currOnline) {
    if (prevOffline.some((ps) => ps.id === s.id)) {
      recoveries.push({
        id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
        type: 'MONITOR.station.recovered',
        category: CATEGORY.STATION,
        severity: SEVERITY.INFO,
        title: `Station ${s.name} recovered`,
        summary: `Station ${s.name} returned to online`,
        evidence: { stationId: s.id, name: s.name },
        timestamp: curr.timestamp,
        snapshotId: curr.id,
        isRecovery: true,
      });
    }
  }
  const prevHealthCritical = prev.stations.filter((s) => s.healthScore < 50 && s.status !== 'OFFLINE');
  const currHealthRecovered = curr.stations.filter((s) => s.healthScore >= 50 && s.status !== 'OFFLINE');
  for (const s of currHealthRecovered) {
    if (prevHealthCritical.some((ps) => ps.id === s.id)) {
      recoveries.push({
        id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
        type: 'MONITOR.station.health_recovered',
        category: CATEGORY.STATION,
        severity: SEVERITY.INFO,
        title: `Station ${s.name} health recovered`,
        summary: `Station ${s.name} health score improved to ${s.healthScore}`,
        evidence: { stationId: s.id, name: s.name, healthScore: s.healthScore },
        timestamp: curr.timestamp,
        snapshotId: curr.id,
        isRecovery: true,
      });
    }
  }
  return recoveries;
}

function routeEvent(event) {
  let action = 'LOG';
  if (event.severity === SEVERITY.CRITICAL) action = 'AGENT_INVESTIGATE';
  else if (event.severity === SEVERITY.HIGH) action = 'AGENT_INVESTIGATE';
  else if (event.severity === SEVERITY.WARNING) action = 'AGENT_OPTIONAL';
  else if (event.severity === SEVERITY.INFO) action = 'LOG';
  return { event, action, priority: event.severity };
}

module.exports = { detectEvents, detectRecoveries, routeEvent, EVENT_RULES, SEVERITY, CATEGORY };
