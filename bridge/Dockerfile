FROM python:3.12-slim

WORKDIR /app

# Install deps first for layer caching
RUN pip install --no-cache-dir meshtastic esptool pyserial flask

# Copy application
COPY server.py .

CMD ["python", "server.py"]
