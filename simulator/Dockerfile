FROM python:3.12-slim
WORKDIR /app

# Dépendances d'abord (cache Docker).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "-u", "main.py"]
