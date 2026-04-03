#!/bin/bash

AUTH="Bearer sk-a2d0981bd84ebf214f4bfb861a273873bfe3e10e6af97533"
BASE_URL="http://localhost:8008/v1/chat/completions"

echo "=== Testing GPT-4 ==="
curl -s "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: $AUTH" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 128
  }' | python3 -m json.tool

echo ""
echo "=== Testing GLM-4.7 ==="
curl -s "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: $AUTH" \
  -d '{
    "model": "glm-4.7",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 128
  }' | python3 -m json.tool
