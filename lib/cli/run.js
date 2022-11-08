#!/usr/bin/env node

'use strict';

require('colorful').colorful();
const gulp = require('gulp');
const program = require('commander'); // 完整的 node.js 命令行解决方案

program.on('--help', () => {
  console.log('  Usage:'.to.bold.blue.color);
  console.log();
});

console.log('process.argv', process.argv);
program.parse(process.argv);

function runTask(toRun) {
  const metadata = { task: toRun };
  // Gulp >= 4.0.0 (doesn't support events)
  const taskInstance = gulp.task(toRun);
  if (taskInstance === undefined) {
    gulp.emit('task_not_found', metadata);
    return;
  }
  const start = process.hrtime();
  gulp.emit('task_start', metadata);
  try {
    taskInstance.apply(gulp);
    metadata.hrDuration = process.hrtime(start);
    gulp.emit('task_stop', metadata);
    gulp.emit('stop');
  } catch (err) {
    err.hrDuration = process.hrtime(start);
    err.task = metadata.task;
    gulp.emit('task_err', err);
  }
}

// 通过program.parse(arguments)方法处理参数，没有被使用的选项会存放在program.args数组中。该方法的参数是可选的，默认值为process.argv
// program.args[0] 是 process.argv[2]
const task = program.args[0];
console.log('task', task);

if (!task) {
  program.help();
} else {
  console.log('antd-tools run', task);

  require('../gulpfile');

  // 运行任务
  runTask(task);
}
