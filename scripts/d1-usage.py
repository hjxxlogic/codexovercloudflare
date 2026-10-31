"""Read-only Wrangler audit of one explicit D1 database; keep evidence local."""
import argparse
import datetime
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
WRANGLER = ROOT / 'node_modules/wrangler/bin/wrangler.js'
SQL = """
SELECT name, sql FROM sqlite_schema WHERE type IN ('table','index');
SELECT CASE WHEN scope = 'registry' THEN 'registry' ELSE 'host' END AS category,
       count(*) AS rows, count(DISTINCT scope) AS scopes,
       sum(length(value)) AS value_bytes FROM relay_state GROUP BY category;
SELECT substr(key,1,instr(key,':')) AS kind, count(*) AS rows,
       sum(length(value)) AS value_bytes FROM relay_state GROUP BY kind;
EXPLAIN QUERY PLAN SELECT value FROM relay_state WHERE scope = 'registry' AND key = 'host:probe';
EXPLAIN QUERY PLAN SELECT key, value FROM relay_state WHERE scope = 'registry'
  AND key >= 'host:' AND key < 'host:zz' ORDER BY key COLLATE BINARY LIMIT 256;
EXPLAIN QUERY PLAN SELECT key, value FROM relay_state WHERE scope = 'host:probe'
  AND key IN ('@migrated','@location','presence');
EXPLAIN QUERY PLAN SELECT revision FROM relay_scopes WHERE scope = 'registry';
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True, help='Existing database name or UUID')
    parser.add_argument('--period', default='1d', choices=['1d', '7d'])
    args = parser.parse_args()
    output = ROOT / '.local/d1-usage' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    output.mkdir(parents=True)

    def query(name, *command):
        result = subprocess.run(['node', str(WRANGLER), 'd1', *command, '--json'],
                                cwd=ROOT, text=True, capture_output=True, check=True)
        data = json.loads(result.stdout)
        (output / (name + '.json')).write_text(json.dumps(data, indent=2) + '\n')
        return data

    info = query('info', 'info', args.database)
    insights = query('insights', 'insights', args.database, '--time-period', args.period,
                     '--sort-by', 'reads', '--limit', '100')
    query('schema-plans', 'execute', args.database, '--remote', '--command', SQL)
    summary = {
        'database': info['name'], 'uuid': info['uuid'], 'period': args.period,
        'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'databaseSize': info['database_size'],
        'readQueries24h': info.get('read_queries_24h'),
        'writeQueries24h': info.get('write_queries_24h'),
        'rowsRead24h': info.get('rows_read_24h'),
        'rowsWritten24h': info.get('rows_written_24h'),
        'insightsQueries': sum(row['numberOfTimesRun'] for row in insights),
        'insightsRowsRead': sum(row['totalRowsRead'] for row in insights),
        'insightsRowsWritten': sum(row['totalRowsWritten'] for row in insights),
        'limitations': 'Insights and info are separate rolling snapshots; insights may be sampled or limited to the top 100 SQL shapes. Audit SELECTs incur reads.',
    }
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
    print('Evidence: ' + str(output.relative_to(ROOT)))


if __name__ == '__main__':
    main()
