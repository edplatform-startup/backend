# Dockerfile for Render
FROM node:20-slim

# Install TeX Live and other dependencies
RUN apt-get update && apt-get install -y \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-science \
  texlive-pictures \
  texlive-lang-english \
  ghostscript \
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm ci --include=dev

# Bundle app source
COPY . .

# Build the app (if needed)
RUN npm run build

# Start the app
CMD [ "npm", "run", "start" ]
