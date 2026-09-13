# SkyGuard AI - LOCAL DEMO MODE SETUP
# This file documents the environment configuration changes needed for local demo mode

## For Local Demo Mode - Run these commands:

export NODE_ENV=development
export DEMO_MODE=true
export CORS_ORIGIN=*
export JWT_SECRET=skyguard-demo-secret-key-with-32+characters
export ADMIN_USERNAME=demo
export ADMIN_PASSWORD=demo123!change
export SKYLIGHT_ADMIN_PASSWORD=demo123!change

## Optional - Open-Meteo API (Free)
export OPENWEATHER_API_KEY=none

## LLM (Optional - for real testing)
export OPENAI_API_KEY=none
export AZURE_OPENAI_ENDPOINT=none
export AZURE_OPENAI_KEY=none

## Launch backend with demo mode:
cd env-dashboard/backend
npm start

## Notes:
- JWT_SECRET must be 32+ characters
- In demo mode, all endpoints are accessible without authentication
- CORS_ORIGIN=* allows local frontend connections
- System will still validate secrets if NODE_ENV=production