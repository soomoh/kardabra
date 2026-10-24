#!/bin/sh
# Regenerate the synthetic PDF fixtures from pdf_statement.ps (Ghostscript).
# The locked copy uses the fabricated password "JANE2010" (NAME4 + DDMM style).
set -e
cd "$(dirname "$0")"
gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile=pdf_statement.pdf pdf_statement.ps
gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOwnerPassword=owner-JANE -sUserPassword=JANE2010 \
  -dEncryptionR=3 -dKeyLength=128 -sOutputFile=pdf_statement_locked.pdf pdf_statement.ps
