FROM python:3.12-alpine

WORKDIR /app

COPY server.py .
COPY index.html style.css app.js icao-countries.js countries.js ./

EXPOSE 8080

CMD ["python", "server.py"]