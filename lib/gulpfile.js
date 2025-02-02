const { getProjectPath, injectRequire, getConfig } = require('./utils/projectHelper'); // eslint-disable-line import/order

injectRequire();

const merge2 = require('merge2');
const { execSync } = require('child_process');
const through2 = require('through2'); // 用来处理 node stream 流
const webpack = require('webpack');
const babel = require('gulp-babel');
const esbuild = require('@umijs/bundler-utils/compiled/esbuild');
const argv = require('minimist')(process.argv.slice(2));
const chalk = require('chalk');
const path = require('path');
const watch = require('gulp-watch');
const ts = require('gulp-typescript');
const gulp = require('gulp');
const glob = require('glob');
const fs = require('fs');
const rimraf = require('rimraf'); // 以包的形式包装 rm -rf 命令，用来删除文件和文件夹
const stripCode = require('gulp-strip-code');
const install = require('./install');
const runCmd = require('./runCmd');
const getBabelCommonConfig = require('./getBabelCommonConfig');
const transformLess = require('./transformLess');
const getNpm = require('./getNpm');
const selfPackage = require('../package.json');
const getNpmArgs = require('./utils/get-npm-args');
const { cssInjection } = require('./utils/styleUtil');
const tsConfig = require('./getTSCommonConfig')();
const replaceLib = require('./replaceLib');
const checkDeps = require('./lint/checkDeps');
const checkDiff = require('./lint/checkDiff');
const apiCollection = require('./apiCollection');
const sortApiTable = require('./sortApiTable');

const packageJson = require(getProjectPath('package.json'));

const tsDefaultReporter = ts.reporter.defaultReporter();
const cwd = process.cwd();
const libDir = getProjectPath('lib');
const esDir = getProjectPath('es');
const localeDir = getProjectPath('locale');

// FIXME: hard code, not find typescript can modify the path resolution
const localeDts = `import type { Locale } from '../es/locale-provider';
declare const localeValues: Locale;
export default localeValues;`;

// 编译 dist
function dist(done) {
  // 删除 dist/
  rimraf.sync(getProjectPath('dist'));

  // 设置自定义的环境变量
  process.env.RUN_ENV = 'PRODUCTION';

  // 获取项目下 webpack 配置，ant-design/webpack.config.js
  const webpackConfig = require(getProjectPath('webpack.config.js'));

  // 执行 webpack 打包行为
  webpack(webpackConfig, (err, stats) => {
    if (err) {
      console.error(err.stack || err);
      if (err.details) {
        console.error(err.details);
      }
      return;
    }

    const info = stats.toJson();
    const { dist: { finalize } = {}, bail } = getConfig();

    if (stats.hasErrors()) {
      (info.errors || []).forEach(error => {
        console.error(error);
      });
      // https://github.com/ant-design/ant-design/pull/31662
      if (bail) {
        process.exit(1);
      }
    }

    if (stats.hasWarnings()) {
      console.warn(info.warnings);
    }

    const buildInfo = stats.toString({
      colors: true,
      children: true,
      chunks: false,
      modules: false,
      chunkModules: false,
      hash: false,
      version: false,
    });
    console.log(buildInfo);

    // Additional process of dist finalize
    if (finalize) {
      console.log('[Dist] Finalization...');
      finalize();
    }

    done(0);
  });
}

const lintWrapper = cmd => done => {
  if (cmd && !Array.isArray(cmd)) {
    console.error('tslint parameter error!');
    process.exit(1);
  }
  const lastCmd = cmd || [];
  const tslintBin = require.resolve('tslint/bin/tslint');
  const tslintConfig = path.join(__dirname, './tslint.json');
  const args = [tslintBin, '-c', tslintConfig, 'components/**/*.tsx'].concat(lastCmd);
  runCmd('node', args, done);
};

function tag() {
  console.log('tagging');
  const { version } = packageJson;
  execSync(`git tag ${version}`);
  execSync(`git push origin ${version}:${version}`);
  execSync('git push origin master:master');
  console.log('tagged');
}

gulp.task(
  'check-git',
  gulp.series(done => {
    runCmd('git', ['status', '--porcelain'], (code, result) => {
      if (/^\?\?/m.test(result)) {
        return done(`There are untracked files in the working tree.\n${result}
      `);
      }
      if (/^([ADRM]| [ADRM])/m.test(result)) {
        return done(`There are uncommitted changes in the working tree.\n${result}
      `);
      }
      return done();
    });
  })
);

gulp.task('clean', () => {
  rimraf.sync(getProjectPath('_site'));
  rimraf.sync(getProjectPath('_data'));
});

// 构建 dist
gulp.task(
  'dist',
  gulp.series(done => {
    dist(done);
  })
);

gulp.task(
  'deps-lint',
  gulp.series(done => {
    checkDeps(done);
  })
);

gulp.task('ts-lint', gulp.series(lintWrapper()));

gulp.task('ts-lint-fix', gulp.series(lintWrapper(['--fix'])));

const tsFiles = ['**/*.ts', '**/*.tsx', '!node_modules/**/*.*', 'typings/**/*.d.ts'];

function compileTs(stream) {
  return stream
    .pipe(ts(tsConfig))
    .js.pipe(
      through2.obj(function (file, encoding, next) {
        // console.log(file.path, file.base);
        file.path = file.path.replace(/\.[jt]sx$/, '.js');
        this.push(file);
        next();
      })
    )
    .pipe(gulp.dest(process.cwd()));
}

gulp.task('tsc', () =>
  compileTs(
    gulp.src(tsFiles, {
      base: cwd,
    })
  )
);

gulp.task(
  'watch-tsc',
  gulp.series('tsc', () => {
    watch(tsFiles, f => {
      if (f.event === 'unlink') {
        const fileToDelete = f.path.replace(/\.tsx?$/, '.js');
        if (fs.existsSync(fileToDelete)) {
          fs.unlinkSync(fileToDelete);
        }
        return;
      }
      const myPath = path.relative(cwd, f.path);
      compileTs(
        gulp.src([myPath, 'typings/**/*.d.ts'], {
          base: cwd,
        })
      );
    });
  })
);

function babelify(js, modules, processLess = true) {
  const babelConfig = getBabelCommonConfig(modules);
  delete babelConfig.cacheDirectory;
  if (modules === false) {
    babelConfig.plugins.push(replaceLib);
  }
  let stream = js.pipe(babel(babelConfig));
  if (processLess) {
    stream = stream.pipe(
      through2.obj(function z(file, encoding, next) {
        this.push(file.clone());
        // 将 style/index.js 替换为 style/css.js，加载 css 文件
        if (file.path.match(/(\/|\\)style(\/|\\)index\.js/)) {
          const content = file.contents.toString(encoding);
          if (content.indexOf("'react-native'") !== -1) {
            // actually in antd-mobile@2.0, this case will never run,
            // since we both split style/index.mative.js style/index.js
            // but let us keep this check at here
            // in case some of our developer made a file name mistake ==
            next();
            return;
          }

          // 将 content 中的 less 换成 css
          file.contents = Buffer.from(cssInjection(content));
          file.path = file.path.replace(/index\.js/, 'css.js');
          this.push(file);
          next();
        } else {
          next();
        }
      })
    );
  }
  return stream.pipe(gulp.dest(modules === false ? esDir : libDir));
}

/**
 * 编译核心代码
 * @param {*} modules
 * @param {*} processLess
 * @param {*} processLocale
 * @returns
 */
function compile(modules, processLess = true, processLocale = true) {
  // 得到 .antd-tools.config.js 中的配置
  const { compile: { transformTSFile, transformFile, includeLessFile = [] } = {} } = getConfig();
  rimraf.sync(modules !== false ? libDir : esDir); // 编译前删除 libDir 或 esDir

  // =============================== LESS ===============================
  let less;

  // 将 less 编译为 css
  if (processLess) {
    less = gulp
      .src(['components/**/*.less'])
      .pipe(
        through2.obj(function (file, encoding, next) {
          // Replace content
          const cloneFile = file.clone();
          const content = file.contents.toString().replace(/^\uFEFF/, '');

          cloneFile.contents = Buffer.from(content);

          // Clone for css here since `this.push` will modify file.path
          const cloneCssFile = cloneFile.clone();

          this.push(cloneFile);

          // Transform less file
          if (
            file.path.match(/(\/|\\)style(\/|\\)index\.less$/) ||
            file.path.match(/(\/|\\)style(\/|\\)v2-compatible-reset\.less$/) ||
            includeLessFile.some(regex => file.path.match(regex))
          ) {
            transformLess(cloneCssFile.contents.toString(), cloneCssFile.path)
              .then(css => {
                cloneCssFile.contents = Buffer.from(css);
                cloneCssFile.path = cloneCssFile.path.replace(/\.less$/, '.css');
                this.push(cloneCssFile);
                next();
              })
              .catch(e => {
                console.error(e);
              });
          } else {
            next();
          }
        })
      )
      .pipe(gulp.dest(modules === false ? esDir : libDir));
  }

  // 输出 png | svg
  const assets = gulp
    .src(['components/**/*.@(png|svg)'])
    .pipe(gulp.dest(modules === false ? esDir : libDir));
  let error = 0;

  // =============================== FILE ===============================
  let transformFileStream;

  // 执行配置中的 transformFile 方法
  if (transformFile) {
    transformFileStream = gulp
      .src(['components/**/*.tsx'])
      .pipe(
        through2.obj(function (file, encoding, next) {
          let nextFile = transformFile(file) || file;
          nextFile = Array.isArray(nextFile) ? nextFile : [nextFile];
          nextFile.forEach(f => this.push(f));
          next();
        })
      )
      .pipe(gulp.dest(modules === false ? esDir : libDir));
  }

  // ================================ TS ================================
  const source = [
    'components/**/*.tsx',
    'components/**/*.ts',
    'typings/**/*.d.ts',
    '!components/**/__tests__/**',
    '!components/**/demo/**',
  ];

  // skip locale files
  if (!processLocale) {
    source.push('!components/**/locale/!(en_US)*');
    source.push('!components/locale-provider/*_*');
  }

  // allow jsx file in components/xxx/
  if (tsConfig.allowJs) {
    source.unshift('components/**/*.jsx');
  }

  // Strip content if needed
  let sourceStream = gulp.src(source);
  if (modules === false) {
    sourceStream = sourceStream.pipe(
      stripCode({
        start_comment: '@remove-on-es-build-begin',
        end_comment: '@remove-on-es-build-end',
      })
    );
  }

  // 执行配置中的 transformTSFile 方法
  if (transformTSFile) {
    sourceStream = sourceStream.pipe(
      through2.obj(function (file, encoding, next) {
        let nextFile = transformTSFile(file) || file;
        nextFile = Array.isArray(nextFile) ? nextFile : [nextFile];
        nextFile.forEach(f => this.push(f));
        next();
      })
    );
  }

  // 将 source 中 ts 文件编译为 js
  const tsResult = sourceStream.pipe(
    ts(tsConfig, {
      error(e) {
        tsDefaultReporter.error(e);
        error = 1;
      },
      finish: tsDefaultReporter.finish,
    })
  );

  function check() {
    if (error && !argv['ignore-error']) {
      process.exit(1);
    }
  }

  tsResult.on('finish', check);
  tsResult.on('end', check);

  // 用 babel 处理 js，将 style/index.js 文件处理为 style/css.js, 引用 css 文件
  const tsFilesStream = babelify(tsResult.js, modules, processLess);

  // 处理 .d.ts
  const tsd = tsResult.dts.pipe(gulp.dest(modules === false ? esDir : libDir));

  // Merge multiple streams into one stream in sequence or parallel.
  return merge2([less, tsFilesStream, tsd, assets, transformFileStream].filter(s => s));
}

function compileLocale(done) {
  rimraf.sync(localeDir);

  const entryPoints = glob.sync('components/locale/*.tsx');

  esbuild.build({
    entryPoints,
    absWorkingDir: cwd,
    format: 'cjs',
    platform: 'node',
    bundle: true,
    outdir: localeDir,
    logLevel: 'silent',
    write: true,
    charset: 'utf8',
    plugins: [
      {
        name: 'antd-tools',
        setup: builder => {
          builder.onResolve({ filter: /.*/ }, args => {
            // skip external modules
            if (!args.path.startsWith('.')) {
              return { path: args.path, external: true };
            }
            return {};
          });

          builder.onEnd(() => {
            entryPoints.forEach(item => {
              const match = item.match(/components\/locale\/(.*)\.tsx/);
              if (match) {
                fs.writeFileSync(`${localeDir}/${match[1]}.d.ts`, localeDts, 'utf8');
              }
            });
            done();
          });
        },
      },
    ],
  });
}

function publish(tagString, done) {
  let args = ['publish', '--with-antd-tools', '--access=public'];
  if (tagString) {
    args = args.concat(['--tag', tagString]);
  }
  const publishNpm = process.env.PUBLISH_NPM_CLI || 'npm';
  runCmd(publishNpm, args, code => {
    console.log('Publish return code:', code);
    if (!argv['skip-tag'] && !code) {
      tag();
    }
    done(code);
  });
}

// We use https://unpkg.com/[name]/?meta to check exist files
// diff 版本
gulp.task(
  'package-diff',
  gulp.series(done => {
    checkDiff(packageJson.name, packageJson.version, done);
  })
);

// 发布
function pub(done) {
  const notOk = !packageJson.version.match(/^\d+\.\d+\.\d+$/);
  let tagString;

  // Argument tag
  if (argv['npm-tag']) {
    tagString = argv['npm-tag'];
  }

  // Config tag
  if (!tagString) {
    const { tag: configTag } = getConfig();
    if (configTag) {
      tagString = configTag;
    }
  }

  // Auto next tag
  if (!tagString && notOk) {
    tagString = 'next';
  }
  if (packageJson.scripts['pre-publish']) {
    runCmd('npm', ['run', 'pre-publish'], code2 => {
      if (code2) {
        done(code2);
        return;
      }
      publish(tagString, done);
    });
  } else {
    publish(tagString, done);
  }
}

// 编译成 es 类型
gulp.task('compile-with-es', done => {
  console.log('[Parallel] Compile to es...');
  compile(false).on('finish', done);
});

gulp.task('compile-with-es-experimental', done => {
  console.log('[Parallel] Compile to es...');
  compile(false, false, false).on('finish', done);
});

gulp.task('compile-with-locale', done => {
  console.log('[Parallel] Compile locale files to js...');
  compileLocale(done);
});

// 编译成 js 类型
gulp.task('compile-with-lib', done => {
  console.log('[Parallel] Compile to js...');
  compile().on('finish', done);
});

gulp.task('compile-finalize', done => {
  // Additional process of compile finalize
  const { compile: { finalize } = {} } = getConfig();
  if (finalize) {
    console.log('[Compile] Finalization...');
    finalize();
  }
  done();
});

// 编译 es、lib
gulp.task(
  'compile',
  gulp.series(gulp.parallel('compile-with-es', 'compile-with-lib'), 'compile-finalize') // 将多个任务合并成更大的任务，按顺序依次执行
);

gulp.task(
  'compile-experimental',
  gulp.series(
    gulp.parallel('compile-with-es-experimental', 'compile-with-locale'),
    'compile-finalize'
  )
);

gulp.task(
  'install',
  gulp.series(done => {
    install(done);
  })
);

// 发布
// git 检查、构建 es、lib、dist，diff package
gulp.task(
  'pub',
  gulp.series('check-git', 'compile', 'dist', 'package-diff', done => {
    pub(done);
  })
);

gulp.task(
  'pub-experimental',
  gulp.series('check-git', 'compile-experimental', 'dist', 'package-diff', done => {
    pub(done);
  })
);

gulp.task(
  'update-self',
  gulp.series(done => {
    getNpm(npm => {
      console.log(`${npm} updating ${selfPackage.name}`);
      runCmd(npm, ['update', selfPackage.name], c => {
        console.log(`${npm} update ${selfPackage.name} end`);
        done(c);
      });
    });
  })
);

gulp.task(
  'guard',
  gulp.series(done => {
    function reportError() {
      console.log(chalk.bgRed('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'));
      console.log(chalk.bgRed('!! `npm publish` is forbidden for this package. !!'));
      console.log(chalk.bgRed('!! Use `npm run pub` instead.                   !!'));
      console.log(chalk.bgRed('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'));
    }
    const npmArgs = getNpmArgs();
    if (npmArgs) {
      for (let arg = npmArgs.shift(); arg; arg = npmArgs.shift()) {
        if (
          /^pu(b(l(i(sh?)?)?)?)?$/.test(arg) &&
          npmArgs.indexOf('--with-antd-tools') < 0 &&
          !process.env.npm_config_with_antd_tools
        ) {
          reportError();
          done(1);
          process.exit(1);
          return;
        }
      }
    }
    done();
  })
);

// 排序 api 表格
gulp.task(
  'sort-api-table',
  gulp.series(done => {
    sortApiTable();
    done();
  })
);

// api 收集
gulp.task(
  'api-collection',
  gulp.series(done => {
    apiCollection();
    done();
  })
);
