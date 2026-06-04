# Kafka Connect + connecteur Apache PLC4X.
# C'est LE seul container JVM de Strata (Phase 4), isolé derrière le profil
# Docker `plc4x` : il ne démarre que si on le demande explicitement.
#
# Le JAR publié `plc4j-apache-kafka` est "maigre" (~37 Ko, sans dépendances).
# On utilise donc Maven pour télécharger le connecteur ET tout son arbre de
# dépendances (drivers de protocoles, libs PLC4X…) dans un seul dossier, qu'on
# copie ensuite dans le plugin path de Kafka Connect.

# ─── Étape 1 : résolution des dépendances via Maven ───────────────────────
FROM maven:3.9-eclipse-temurin-17 AS deps

ARG PLC4X_VERSION=0.12.0
WORKDIR /build

# Un POM minimal dont la seule dépendance est le connecteur Kafka PLC4X.
RUN printf '%s\n' \
  '<project xmlns="http://maven.apache.org/POM/4.0.0">' \
  '  <modelVersion>4.0.0</modelVersion>' \
  '  <groupId>strata</groupId>' \
  '  <artifactId>plc4x-deps</artifactId>' \
  '  <version>1.0</version>' \
  '  <packaging>pom</packaging>' \
  '  <dependencies>' \
  '    <dependency>' \
  '      <groupId>org.apache.plc4x</groupId>' \
  '      <artifactId>plc4j-apache-kafka</artifactId>' \
  "      <version>${PLC4X_VERSION}</version>" \
  '    </dependency>' \
  '  </dependencies>' \
  '</project>' > pom.xml

# Copie le connecteur + TOUTES ses dépendances runtime dans /build/plugin.
RUN mvn -q -B dependency:copy-dependencies \
      -DoutputDirectory=/build/plugin \
      -DincludeScope=runtime

# ─── Étape 2 : image finale Kafka Connect ─────────────────────────────────
FROM confluentinc/cp-kafka-connect:7.7.1

USER root
COPY --from=deps /build/plugin/ /usr/share/java/plc4x-kafka/
USER appuser
