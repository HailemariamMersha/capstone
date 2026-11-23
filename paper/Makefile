PYTHON ?= python3
TECTONIC ?= tectonic
TEXBUILD := ../build/paper-tex
DELIVERY := ../output/pdf

.PHONY: all figures pdf clean
all: pdf

figures:
	$(PYTHON) scripts/make_figures.py

pdf: figures
	mkdir -p $(TEXBUILD) $(DELIVERY)
	$(TECTONIC) --keep-logs --keep-intermediates --outdir $(TEXBUILD) main.tex
	cp $(TEXBUILD)/main.pdf $(DELIVERY)/skymeasure-progress.pdf

clean:
	rm -f $(TEXBUILD)/main.aux $(TEXBUILD)/main.bbl $(TEXBUILD)/main.blg $(TEXBUILD)/main.log $(TEXBUILD)/main.out
