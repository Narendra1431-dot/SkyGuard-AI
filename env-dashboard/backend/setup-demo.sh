#!/bin/bash

# SkyGuard AI - Local Demo Mode Setup Script
# This script sets up the environment for running SkyGuard AI locally with demo mode

set -e

echo "=== SkyGuard AI Local Demo Mode Setup ==="

# Create .env file if it doesn't exist
if [ ! -f "env-dashboard/backend/.env" ]; then
    cat > env-dashboard/backend/.env << EOF
# Local Development Environment
NODE_ENV=development
DEMO_MODE=true
CORS_ORIGIN=*
JWT_SECRET=skyguard-demo-secret-key-with-32-plus-chars
skyguard-admin-username=demo
skyguard-admin-password=demo123!change

# OpenMeteo Provider (Free)
SKYLIGHT_PROVIDER_MODE=open-meteo

# LLM (Optional - for testing real LLM)
OPENAI_API_KEY=none
OLLAMA_BASE_URL=http://localhost:11434

# Storage
INFLUX_URL=http://localhost:8086
INFLUX_TOKEN=skyguard-token
INFLUX_ORG=skyguard
INFLUX_BUCKET=env_data
USE_INFLUXDB=false

# UI
PORT=8080
EOF
    echo "✓ Created .env file"
else
    echo "✓ .env file already exists"
fi

# Install backend dependencies if needed
if [ ! -d "env-dashboard/backend/node_modules" ]; then
    echo "Installing backend dependencies..."
    cd env-dashboard/backend
    npm install
    cd ../..
    echo "✓ Backend dependencies installed"
else
    echo "✓ Backend dependencies already installed"
fi

# Install frontend dependencies if needed
if [ ! -d "env-dashboard/frontend/node_modules" ]; then
    echo "Installing frontend dependencies..."
    cd env-dashboard/frontend
    npm install
    cd ../..
    echo "✓ Frontend dependencies installed"
else
    echo "✓ Frontend dependencies already installed"
fi

# Start backend in background
echo "Starting backend server..."
export NODE_ENV=development
export DEMO_MODE=true
export CORS_ORIGIN="*"
export JWT_SECRET="skyguard-demo-secret-key-with-32-plus-chars"
export SKYLIGHT_ADMIN_USERNAME="demo"
export SKYLIGHT_ADMIN_PASSWORD="demo123!change"

cd env-dashboard/backend
if [ ! -f server.js ]; then
    echo "Error: server.js not found in backend directory"
    exit 1
fi

# Check if backend is already running
if ss -tlnp | grep -q ':4000'; then
    echo "✓ Backend server is already running on port 4000"
else
    # Start backend in background
    node server.js > backend.log 2>&1 &
    BACKEND_PID=$!
    echo "✓ Backend server started (PID: $BACKEND_PID)"
    
    # Wait for backend to start
    sleep 3
    
    # Check if backend is running
    if curl -s http://localhost:4000/api/v1/health > /dev/null; then
        echo "✓ Backend health check passed"
    else
        echo "✗ Backend health check failed - check backend.log"
        cat backend.log
        exit 1
    fi
fi

# Start frontend in background
echo "Starting frontend..."
cd env-dashboard/frontend

# Check if frontend is already running
if ss -tlnp | grep -q ':8080'; then
    echo "✓ Frontend server is already running on port 8080"
else
    # Start frontend
    npm start > frontend.log 2>&1 &
    FRONTEND_PID=$!
    echo "✓ Frontend server started (PID: $FRONTEND_PID)"
    
    # Wait for frontend to start
    sleep 2
    
    # Check if frontend is running
    if curl -s http://localhost:8080 > /dev/null; then
        echo "✓ Frontend server started successfully"
    else
        echo "✗ Frontend server may not be running - check frontend.log"
        cat frontend.log
    fi
fi

# Save PIDs for easy stop
echo $BACKEND_PID > env-dashboard/backend/backend.pid
echo $FRONTEND_PID > env-dashboard/frontend/frontend.pid

cd ..

echo ""
echo "=== Local Demo Mode Setup Complete ==="
echo ""
echo "To stop the demo:"./stop-demo.sh"
echo ""
echo "Access the application at: http://localhost:8080"
echo "Backend API: http://localhost:4000/api/v1/health"
echo "Demo mode enabled: Yes (no authentication required)"
echo "CORS Origin: * (allowing all origins for local development)"