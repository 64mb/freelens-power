import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("packed captures and API transport load without installed dependencies or native database assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "power-logs-package-test-"));
  try {
    const project = join(directory, "project");
    const unpacked = join(directory, "unpacked");
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    await mkdir(project);
    await cp("dist", join(project, "dist"), { recursive: true });
    await cp("THIRD_PARTY_LICENSES", join(project, "THIRD_PARTY_LICENSES"));
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    // old build output must never reintroduce native assets into the package
    await mkdir(join(project, "dist/duckdb/native"), { recursive: true });
    await writeFile(join(project, "dist/duckdb/native/duckdb.node"), "stale native asset");
    const environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key))),
      NODE_PATH: "",
    };
    const [packed] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--cache", join(directory, "cache"), "--pack-destination", directory],
        { cwd: project, encoding: "utf8", env: environment },
      ),
    );
    const files = /** @type {{files: {path: string}[]}} */ (packed).files.map(({ path }) => path);
    assert.equal(files.some((path) => /duckdb|\.(?:node|so|dylib|dll)$/i.test(path)), false);
    assert.equal(Object.keys(manifest.dependencies).some((name) => name.startsWith("@duckdb/")), false);
    assert.ok(files.includes("dist/power-logs-child.js"));
    assert.ok(files.includes("dist/power-logs-query-child.js"));
    await mkdir(unpacked);
    execFileSync("tar", ["-xzf", join(directory, packed.filename), "--strip-components=1", "-C", unpacked]);
    assert.equal(existsSync(join(unpacked, "node_modules")), false);
    const transport = execFileSync(
      process.execPath,
      ["-e", `
        globalThis.FreelensExtensionApi={Common:{},Main:{Util:{fetch:globalThis.fetch}},Renderer:{}};
        const {registerHooks}=require('node:module');
        registerHooks({resolve(specifier,context,next){return specifier==='electron'?{url:'data:text/javascript,export const app={}; export const safeStorage={}; export const net={};',shortCircuit:true}:next(specifier,context)}});
        (async()=>{
        const {createCodexApiSession}=await import('./dist/ai-codex-api.js');
        const session=createCodexApiSession('example',{},'');
        session.close();
        process.stdout.write('ready');
        })().catch(error=>{console.error(error);process.exitCode=1});
      `],
      { cwd: unpacked, encoding: "utf8", env: environment },
    );
    assert.equal(transport, "ready");
    for (const file of files.filter((path) => path.endsWith(".js"))) {
      assert.doesNotMatch(await readFile(join(unpacked, file), "utf8"), /@duckdb\//);
    }
    const output = execFileSync(
      process.execPath,
      ["-e", `
        (async()=>{
        const {PowerLogsDatabase}=await import('./dist/power-logs-database.js');
        const {runPowerLogsQuery}=await import('./dist/power-logs-query.js');
          const database=new PowerLogsDatabase('./captures');
          try {
            const context={clusterId:'example-cluster',contextId:'example-context'};
            const capture=await database.run({...context,operation:'create',target:{kind:'pod',namespace:'default',name:'example'}});
            const request={...context,captureId:capture.id};
            await database.run({...request,operation:'append',records:[{timestamp:0,pod:'example',podUid:'example-uid',container:'app',level:'info',message:'hello',fieldsJson:'{"message":"hello"}',previous:false}]});
            await database.run({...request,operation:'finish',notes:[]});
            const snapshot=await database.run({...request,operation:'query',sql:'SELECT count(*) FROM logs'});
            const result=runPowerLogsQuery(snapshot.database,"SELECT count(*) AS lines, json_extract(fieldsJson, '$.message') AS message, previous FROM logs");
            if(result.error) throw new Error(result.error);
            process.stdout.write(JSON.stringify(result.rows));
          } finally { database.close(); }
        })().catch((error)=>{console.error(error);process.exitCode=1;});
      `],
      { cwd: unpacked, encoding: "utf8", env: environment },
    );
    assert.deepEqual(JSON.parse(output), [[1, "hello", 0]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
