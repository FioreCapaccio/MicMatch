import sys
from pathlib import Path

# mic_match.py vive in python/, un livello sopra questa cartella tests/.
# Aggiunto esplicitamente a sys.path invece di affidarsi al rootdir/cwd da
# cui viene lanciato pytest, cosi' "import mic_match" funziona sempre allo
# stesso modo (es. lanciando pytest dalla root del progetto o da python/).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
