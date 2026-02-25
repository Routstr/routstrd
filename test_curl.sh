#!/bin/bash
curl -X POST "http://localhost:8008/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma-3n-e4b-it",
    "messages": [
      {"role":"system","content":"You are Routstr."},
      {"role":"user","content":"Ping the node"}
    ]
  }'
