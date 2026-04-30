.PHONY: bootstrap format format-check lint build test check xcodegen dev clean

bootstrap:
	./scripts/bootstrap.sh

format:
	./scripts/format.sh

format-check:
	./scripts/format-check.sh

lint:
	./scripts/lint.sh

build:
	./scripts/build.sh

test:
	./scripts/test.sh

check:
	./scripts/check.sh

xcodegen:
	./scripts/generate-xcodeproj.sh

dev:
	./scripts/dev.sh

clean:
	rm -rf .build
