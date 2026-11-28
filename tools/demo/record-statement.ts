import { statementDemoManual } from '@meridian/ai';
process.stdout.write(JSON.stringify({ method: 'manual', ...statementDemoManual('FR') }));
