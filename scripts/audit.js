const { exec } = require('child_process');

const AUDIT_LEVEL = 'high';

console.log(`Running 'npm audit' for vulnerabilities with severity >= ${AUDIT_LEVEL}...`);

// The '--audit-level' flag sets the minimum severity that will cause the command to exit with a non-zero code.
// We pipe stdout and stderr to the current process to see the full report from npm.
const auditProcess = exec(`npm audit --audit-level=${AUDIT_LEVEL}`);

auditProcess.stdout.pipe(process.stdout);
auditProcess.stderr.pipe(process.stderr);

auditProcess.on('exit', (code) => {
  if (code === 0) {
    console.log('\n✅ Success: No new vulnerabilities found with severity >= high.');
    process.exit(0);
  } else {
    // npm audit exits with a non-zero code if vulnerabilities are found at or above the specified level.
    // The exit code is a bitmask of the severities found.
    console.error(`\n❌ Failure: Vulnerabilities found. See the report above for details.`);
    // We exit with 1 to indicate a generic failure, which is standard for CI environments.
    process.exit(1);
  }
});