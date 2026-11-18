.PHONY: install build test lint dev

install:
	npm install
	npm run build

build:
	npm run build

lint:
	npm run lint

test:
	npm run lint
	npm test

dev: build
	npm start
