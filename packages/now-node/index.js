const { createLambda } = require('@now/build-utils/lambda.js');
const download = require('@now/build-utils/fs/download.js');
const FileBlob = require('@now/build-utils/file-blob.js');
const FileFsRef = require('@now/build-utils/file-fs-ref.js');
const fs = require('fs');
const glob = require('@now/build-utils/fs/glob.js');
const path = require('path');
const { promisify } = require('util');
const {
  runNpmInstall,
  runPackageJsonScript,
} = require('@now/build-utils/fs/run-user-scripts.js');

const readFile = promisify(fs.readFile);

/** @typedef { import('@now/build-utils/file-ref') } FileRef */
/** @typedef {{[filePath: string]: FileRef}} Files */

/**
 * @typedef {Object} BuildParamsType
 * @property {Files} files - Files object
 * @property {string} entrypoint - Entrypoint specified for the builder
 * @property {string} workPath - Working directory for this build
 */

/**
 * @param {BuildParamsType} buildParams
 * @param {Object} [options]
 * @param {string[]} [options.npmArguments]
 */
async function downloadInstallAndBundle(
  { files, entrypoint, workPath },
  { npmArguments = [] },
) {
  const userPath = path.join(workPath, 'user');
  const nccPath = path.join(workPath, 'ncc');

  console.log('downloading user files...');
  const filesOnDisk = await download(files, userPath);

  console.log('running npm install for user...');
  const entrypointFsDirname = path.join(userPath, path.dirname(entrypoint));
  await runNpmInstall(entrypointFsDirname, npmArguments);

  console.log('writing ncc package.json...');
  await download(
    {
      'package.json': new FileBlob({
        data: JSON.stringify({
          dependencies: {
            '@zeit/ncc': '0.1.3-webpack',
          },
        }),
      }),
    },
    nccPath,
  );

  console.log('running npm install for ncc...');
  await runNpmInstall(nccPath, npmArguments);
  return [filesOnDisk, nccPath, entrypointFsDirname];
}

async function compile(workNccPath, input) {
  const ncc = require(path.join(workNccPath, 'node_modules/@zeit/ncc'));
  return ncc(input);
}

exports.config = {
  maxLambdaSize: '5mb',
};

/**
 * @param {BuildParamsType} buildParams
 * @returns {Promise<Files>}
 */
exports.build = async ({ files, entrypoint, workPath }) => {
  const [
    filesOnDisk,
    workNccPath,
    entrypointFsDirname,
  ] = await downloadInstallAndBundle(
    { files, entrypoint, workPath },
    { npmArguments: ['--prefer-offline'] },
  );

  console.log('running user script...');
  await runPackageJsonScript(entrypointFsDirname, 'now-build');

  console.log('compiling entrypoint with ncc...');
  const data = await compile(workNccPath, filesOnDisk[entrypoint].fsPath);
  const blob = new FileBlob({ data });

  console.log('preparing lambda files...');
  // move all user code to 'user' subdirectory
  const compiledFiles = { [path.join('user', entrypoint)]: blob };
  const launcherPath = path.join(__dirname, 'launcher.js');
  let launcherData = await readFile(launcherPath, 'utf8');

  launcherData = launcherData.replace(
    '// PLACEHOLDER',
    [
      'process.chdir("./user");',
      `listener = require("./${path.join('user', entrypoint)}");`,
    ].join(' '),
  );

  const launcherFiles = {
    'launcher.js': new FileBlob({ data: launcherData }),
    'bridge.js': new FileFsRef({ fsPath: require('@now/node-bridge') }),
  };

  const lambda = await createLambda({
    files: { ...compiledFiles, ...launcherFiles },
    handler: 'launcher.launcher',
    runtime: 'nodejs8.10',
  });

  return { [entrypoint]: lambda };
};

exports.prepareCache = async ({ files, entrypoint, cachePath }) => {
  await downloadInstallAndBundle({ files, entrypoint, workPath: cachePath });

  return {
    ...(await glob('user/node_modules/**', cachePath)),
    ...(await glob('user/package-lock.json', cachePath)),
    ...(await glob('user/yarn.lock', cachePath)),
    ...(await glob('ncc/node_modules/**', cachePath)),
    ...(await glob('ncc/package-lock.json', cachePath)),
    ...(await glob('ncc/yarn.lock', cachePath)),
  };
};
