const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data', 'ml');
const EVAL_FILE = path.join(DATA_DIR, 'eval.jsonl');
const DATASET_FILE = path.join(DATA_DIR, 'dataset.jsonl');

// Helper to load existing eval data
function loadEvalData() {
    try {
        if (!fs.existsSync(EVAL_FILE)) return [];
        const content = fs.readFileSync(EVAL_FILE, 'utf8');
        return content.split('\n').filter(l => l && l.trim()).map(l => JSON.parse(l));
    } catch (_) {
        return [];
    }
}

// Helper to check if reading is in training dataset
function isInTrainingDataset(raw, existingEvalRecords) {
    if (!raw || typeof raw !== 'object') return false;
    
    const key = JSON.stringify({
        time: raw.time || raw.timestamp,
        stationId: raw.stationId,
        temperature: raw.temperature,
        pressure: raw.pressure,
        humidity: raw.humidity,
        aqi: raw.aqi,
        wind: raw.wind,
        rainfall: raw.rainfall,
        label: raw.label
    });
    
    // Check if this exact reading (based on key) is already in eval records
    return existingEvalRecords.some(evalRecord => {
        if (!evalRecord.raw) return false;
        const evalKey = JSON.stringify({
            time: evalRecord.raw.time || evalRecord.raw.timestamp,
            stationId: evalRecord.raw.stationId,
            temperature: evalRecord.raw.temperature,
            pressure: evalRecord.raw.pressure,
            humidity: evalRecord.raw.humidity,
            aqi: evalRecord.raw.aqi,
            wind: evalRecord.raw.wind,
            rainfall: evalRecord.raw.rainfall,
            label: evalRecord.label
        });
        return key === evalKey;
    });
}

// Helper to check for same-event leakage
function hasSameEventLeakage(raw, existingEvalRecords) {
    if (!raw || typeof raw !== 'object') return false;
    
    const time = raw.time || raw.timestamp;
    const stationId = raw.stationId;
    
    // Check if any existing eval record has the same timestamp and station
    return existingEvalRecords.some(evalRecord => {
        if (!evalRecord.raw) return false;
        const evalTime = evalRecord.raw.time || evalRecord.raw.timestamp;
        const evalStationId = evalRecord.raw.stationId;
        return time === evalTime && stationId === evalStationId;
    });
}

// Get existing labels to check for duplicates
function getExistingLabels() {
    try {
        if (!fs.existsSync(EVAL_FILE)) return new Set();
        const content = fs.readFileSync(EVAL_FILE, 'utf8');
        const records = content.split('\n').filter(l => l && l.trim()).map(l => JSON.parse(l));
        return new Set(records.map(r => {
            const key = JSON.stringify({
                time: r.raw?.time || r.raw?.timestamp,
                stationId: r.raw?.stationId,
                label: r.label
            });
            return key;
        }));
    } catch (_) {
        return new Set();
    }
}

// Human label validation middleware
function validateHumanLabel(req, res, next) {
    const { features, label, reviewerId, reason, rawData } = req.body;
    
    if (!features || !Array.isArray(features)) {
        return res.status(400).json({ success: false, error: 'Features array required' });
    }
    
    if (typeof label !== 'boolean' && label !== 0 && label !== 1) {
        return res.status(400).json({ success: false, error: 'Label must be NORMAL (0) or ANOMALY (1)' });
    }
    
    if (!reviewerId) {
        return res.status(400).json({ success: false, error: 'Reviewer ID required' });
    }
    
    if (!reason) {
        return res.status(400).json({ success: false, error: 'Reason for label required' });
    }
    
    // Raw data is required for validation
    if (!rawData || typeof rawData !== 'object') {
        return res.status(400).json({ success: false, error: 'Raw data required for validation' });
    }
    
    // Call next to proceed with route handler
    next();
}

// Submit human label
router.post('/human-label', validateHumanLabel, async (req, res) => {
    try {
        const { features, label, reviewerId, reason, notes, rawData } = req.body;
        const timestamp = new Date().toISOString();
        
        // Load existing eval data
        const existingEvalRecords = loadEvalData();
        const existingLabels = getExistingLabels();
        
        // Validation checks
        const validationErrors = [];
        
        // Check 1: Not already in training dataset
        if (isInTrainingDataset(rawData, existingEvalRecords)) {
            validationErrors.push('Sample already in training dataset');
        }
        
        // Check 2: Not duplicate
        const rawKey = JSON.stringify({
            time: rawData.time || rawData.timestamp,
            stationId: rawData.stationId,
            temperature: rawData.temperature,
            pressure: rawData.pressure,
            humidity: rawData.humidity,
            aqi: rawData.aqi,
            wind: rawData.wind,
            rainfall: rawData.rainfall,
            label: label
        });
        if (existingLabels.has(rawKey)) {
            validationErrors.push('Sample is a duplicate of an existing labeled record');
        }
        
        // Check 3: Same-event leakage
        if (hasSameEventLeakage(rawData, existingEvalRecords)) {
            validationErrors.push('Sample has same-event leakage (same timestamp and station as existing label)');
        }
        
        // Check 4: Valid feature schema
        const expectedFeatures = ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'];
        if (!features || !Array.isArray(features) || features.length !== expectedFeatures.length) {
            validationErrors.push('Invalid feature schema');
        }
        
        // Check 5: Valid label
        if (label !== 0 && label !== 1) {
            validationErrors.push('Invalid label value');
        }
        
        // Check 6: Provenance exists
        if (!rawData || typeof rawData !== 'object') {
            validationErrors.push('Provenance data missing');
        }
        
        // If validation fails, return error
        if (validationErrors.length > 0) {
            return res.status(400).json({
                success: false,
                error: validationErrors.join('; '),
                validationErrors
            });
        }
        
        // Create human label record with provenance
        const labelRecord = {
            features,
            label,
            reviewerId,
            reason: reason || notes,
            timestamp,
            source: 'human_labeling_workflow',
            validated: true,
            approved: true,
            raw: rawData,
            provenance: {
                station: rawData.stationId,
                timestamp: rawData.time || rawData.timestamp,
                temperature: rawData.temperature,
                humidity: rawData.humidity,
                pressure: rawData.pressure,
                wind: rawData.wind,
                aqi: rawData.aqi,
                rainfall: rawData.rainfall
            }
        };
        
        // Append to eval.jsonl
        try {
            // Ensure data directory exists
            fs.mkdirSync(DATA_DIR, { recursive: true });
            
            // Append record to eval.jsonl
            fs.appendFileSync(EVAL_FILE, JSON.stringify(labelRecord) + '\n');
        } catch (writeError) {
            console.error('[humanLabeling] Failed to write to eval.jsonl:', writeError);
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to save label to evaluation dataset',
                details: writeError.message
            });
        }
        
        res.json({
            success: true,
            data: labelRecord,
            message: 'Human label recorded successfully and added to evaluation dataset',
            timestamp,
            validationPassed: true
        });
    } catch (error) {
        console.error('[humanLabeling] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get human label statistics
router.get('/human-label-stats', async (req, res) => {
    try {
        // Load existing eval data
        const evalRecords = loadEvalData();
        
        // Count by label
        const normalCount = evalRecords.filter(r => r.label === 0).length;
        const anomalyCount = evalRecords.filter(r => r.label === 1).length;
        const totalReviewed = normalCount + anomalyCount;
        
        // Determine class balance
        const classBalance = {
            normal: normalCount,
            anomaly: anomalyCount,
            ratio: totalReviewed > 0 ? (anomalyCount / totalReviewed * 100).toFixed(1) + '%' : '0%'
        };
        
        res.json({
            success: true,
            data: {
                totalReviewed,
                normalCount,
                anomalyCount,
                pendingCount: 0,
                rejectedCount: 0,
                datasetVersion: '1.0.0',
                classBalance,
                lastUpdated: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});