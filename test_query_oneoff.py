import local_test
import sys

# Reconfigure stdout to UTF-8 to support printing emojis and Chinese characters on Windows
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

print("=== Running crawler ===")
kmb = local_test.fetch_kmb_bbi()
# For quick testing, we can limit CTB schemes or fetch them all
ctb = local_test.fetch_ctb_bbi()

print("Grouping records...")
db = local_test.group_bbi_records(kmb + ctb)

print("\n=== Querying Route 968 (KMB) ===")
local_test.query_route("968", db)

print("\n=== Querying Route A10 (CTB) ===")
local_test.query_route("A10", db)
