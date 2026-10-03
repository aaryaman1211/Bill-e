# Container image for Google Cloud Run.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Cloud Run sets $PORT. Firestore credentials come from the service's identity,
# and the Azure key from an environment variable - no secret files in the image.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 60 app:app
