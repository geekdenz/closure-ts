'use strict';

var doctrine = require('doctrine');
var esprima = require('esprima');
var estraverse = require('estraverse');
var Syntax = estraverse.Syntax;
var deepEqual = require('deep-equal');
var espurify = require('espurify');
var printer = require('./printer');
var util = require('./util');

function generate(code) {
  var ast = esprima.parse(code, {
    comment: true,
    attachComment: true,
    loc: true
  });
  var declarations = {};
  var provides = [];
  ast.body.forEach(function(statement) {
    try {
      parseStatement(statement, declarations, provides);
    } catch (e) {
      console.error(statement);
      throw e;
    }
  });
  return printer(declarations, provides);
}

function parseStatement(statement, declarations, provides) {
  if (statement.type === Syntax.IfStatement ||
      statement.type === Syntax.TryStatement) {
    // TODO: ignore top level IfStatement or TryStatement now.
    return;
  }

  if (extractProvide(statement, provides)) {
    return;
  }

  var comments = statement.leadingComments;
  if (!comments || !comments.length) {
    return;
  }
  comments = comments.filter(function(comment) {
    return comment.type === 'Block' && comment.value.charAt(0) === '*';
  });
  var comment = comments[comments.length - 1];
  if (!comment) {
    return;
  }

  var doc = doctrine.parse(comment.value, {
    unwrap: true,
    tags: [
      'param',
      'enum',
      'return',
      'private',
      'type',
      'template',
      'typedef',
      'constructor',
      'interface',
      'extends',
      'override'
    ]
  });
  // console.log(doc.tags);

  var typedefTag = getTypedefTag(doc.tags);
  var isClass = isClassDeclaration(statement, doc.tags);
  var isInterface = isInterfaceDeclaration(statement, doc.tags);
  var enumTag = getEnumTag(doc.tags);
  if (isPrivate(doc.tags)) {
    if (isClass) {
      isClass = false;
      isInterface = true;
    } else if (!typedefTag && !enumTag) {
      return;
    }
  }

  var fullname = getFullName(statement);
  if (!fullname) {
    return;
  }
  var root = fullname[0];
  if (root !== 'goog' && root !== 'proto2' && root !== 'osapi' && root !== 'svgpan') {
    return;
  }
  if (isToIgnore(fullname.join('.'))) {
    return;
  }
  var name = fullname.pop();
  var className = null;
  var isStatic = false;
  if (fullname[fullname.length - 1] === 'prototype') {
    if (isEmptyOverride(doc, statement)) {
      return;
    }
    // consume 'prototype'
    fullname.pop();
    className = fullname.pop();
  } else if (isStaticMember(fullname, declarations)) {
    if (!isClass && !isInterface && !enumTag && !typedefTag) {
      className = fullname.pop();
      isStatic = true;
    }
  }
  var moduleName = fullname.join('.');

  if (moduleName === 'goog.global') {
    return;
  }

  var moduleInfo = declarations[moduleName];
  if (!moduleInfo) {
    moduleInfo = declarations[moduleName] = {
      vars: [],
      typedefs: [],
      functions: [],
      interfaces: [],
      enums: [],
      classes: [],
      classIndex: {}
    };
  }

  var classInfo;
  if (moduleInfo) {
    classInfo = moduleInfo.classIndex[className];
  }
  if (className && !classInfo) {
    // the class is private
    return;
  }

  if (isClass || isInterface) {
    classInfo = {
      name: name,
      type: isClass ? 'ClassType' : isInterface ? 'InterfaceType' : null,
      cstr: getClassConstructorAnnotation(doc.tags),
      parents: getParentClasses(doc.tags),
      templates: getTemplates(doc.tags),
      methods: [],
      props: [],
      comment: comment
    };
    moduleInfo.classes.push(classInfo);
    moduleInfo.classIndex[name] = classInfo;
    return;
  }

  if (isFunctionDeclaration(statement, doc.tags)) {
    var functionInfo = {
      name: name,
      type: getFunctionAnnotation(doc.tags),
      templates: getTemplates(doc.tags),
      isStatic: isStatic,
      comment: comment
    };

    if (className) {
      classInfo.methods.push(functionInfo);
    } else {
      moduleInfo.functions.push(functionInfo);
    }
    return;
  }

  if (enumTag) {
    moduleInfo.enums.push({
      name: name,
      type: getTsType(enumTag.type),
      keys: getEnumKeys(statement),
      original: getOriginalEnum(statement),
      comment: comment
    });
    return;
  }

  if (typedefTag) {
    moduleInfo.typedefs.push({
      name: name,
      type: getTsType(typedefTag.type),
      comment: comment
    });
    return;
  }

  var varInfo = {
    name: name,
    type: getTypeAnnotation(doc.tags, statement),
    isStatic: isStatic,
    comment: comment
  };
  if (className) {
    moduleInfo.classIndex[className].props.push(varInfo);
  } else {
    moduleInfo.vars.push(varInfo);
  }
}

function extractProvide(statement, provides) {
  if (statement.type === Syntax.ExpressionStatement &&
      statement.expression.type === Syntax.CallExpression) {
    var callExp = statement.expression;
    if (callExp.arguments.length === 1 &&
        callExp.arguments[0].type === Syntax.Literal &&
        deepEqual(espurify(callExp.callee), {
      'type': 'MemberExpression',
      'computed': false,
      'object': {
        'type': 'Identifier',
        'name': 'goog'
      },
      'property': {
        'type': 'Identifier',
        'name': 'provide'
      }
    })) {
      provides.push(callExp.arguments[0].value);
      return true;
    }
  }
  return false;
}

function isToIgnore(name) {
  var ignoreList = {
    'goog.debug.LogManager': true,
    'goog.net.BrowserChannel.LogSaver': true,
    'goog.net.cookies.MAX_COOKIE_LENGTH': true,
    'goog.ui.AbstractSpellChecker.prototype.getHandler': true
  };
  return (name in ignoreList);
}

function isStaticMember(fullname, declarations) {
  var className = fullname[fullname.length - 1];
  var moduleName = fullname.slice(0, -1).join('.');
  var moduleInfo = declarations[moduleName];
  if (moduleInfo && moduleInfo.classIndex[className]) {
    // InterfaceType doesn't have static members.
    return moduleInfo.classIndex[className].type === 'ClassType';
  }
  return false;
}

function isPrivate(tags) {
  return tags.some(function(tag) {
    return tag.title === 'private';
  });
}

function isEmptyOverride(doc, statement) {
  var tags = doc.tags;
  var hasOverride = false;
  var hasDescription = !!doc.description;
  var hasType = false;
  tags.forEach(function(tag) {
    var title = tag.title;
    hasOverride = hasOverride || title === 'override';
    hasDescription = hasDescription || (tag.description && tag.description !== '*');
    hasType = hasType || title === 'param' || title === 'return' ||
      title === 'this' || title === 'type' || title === 'template';
  });

  if (hasOverride && !hasType) {
    // return !(hasDescription && isAssignement(statement));
    return true;
  }

  return false;
}

function getEnumTag(tags) {
  for (var i = 0; i < tags.length; i++) {
    if (tags[i].title === 'enum') {
      return tags[i];
    }
  }
  return null;
}

function getTypedefTag(tags) {
  for (var i = 0; i < tags.length; i++) {
    if (tags[i].title === 'typedef') {
      return tags[i];
    }
  }
  return null;
}

function getEnumKeys(statement) {
  if (statement.expression.right.type !== 'ObjectExpression') {
    return [];
  }
  return statement.expression.right.properties.map(function(property) {
    var key = property.key;
    switch (key.type) {
      case 'Identifier':
        return key.name;
      case 'Literal':
        return key.raw;
      default:
        throw new Error('getEnumKeys(): Unexpected key:' + key.type);
    }
  });
}

function getOriginalEnum(statement) {
  var right = statement.expression.right;
  if (right.type === 'Identifier' || right.type === 'MemberExpression') {
    return getMemberExpressionNameList(right).join('.');
  }
  return null;
}

function getTsType(type, opts) {
  opts = opts || {};
  if (!type) {
    // no type property if doctrine fails to parse type.
    return 'any';
  }

  // TODO: use doctrine.Styntax
  switch (type.type) {
    case 'NameExpression':
      var typeName = util.renameReservedModuleName(type.name);
      typeName = replaceTypeName(typeName);
      var paramNum = getTsGenericTypeParamNum(type.name);
      if (paramNum && !opts.isChildOfTypeApplication) {
        var typeParams = [];
        for (var i = 0; i < paramNum; i++) {
          typeParams.push('any');
        }
        return typeName + '<' + typeParams.join(', ') + '>';
      }
      return typeName;
    case 'AllLiteral':
    case 'NullableLiteral':
      return 'any';
    case 'VoidLiteral':
    case 'NullLiteral':
    case 'UndefinedLiteral':
      return 'void';
    case 'OptionalType':
      return getTsType(type.expression);
    case 'NullableType':
    case 'NonNullableType':
      // Every types in TypeScript is a nullable.
      // There is not any non-nullables.
      return getTsType(type.expression);
    case 'UnionType':
      var union = type.elements.map(function(el) {return getTsType(el, {isUnionTypeMember: true});}).join('|');
      if (opts.isRestType) {
        union = '(' + union + ')';
      }
      return union;
    case 'RestType':
      var expression = type.expression;
      if (expression.type === 'ArrayType' && expression.elements.length === 1) {
        // TODO: Only in function type
        expression = expression.elements[0];
      }
      return getTsType(expression, {isRestType: true}) + '[]';
    case 'TypeApplication':
      return getTypeApplicationString(type);
    case 'FunctionType':
      var params = type.params.map(function(paramType, index) {
        return {
          type: getTsType(paramType),
          name: getArgName('arg' + index, paramType)
        };
      });
      return toFunctionTypeString(params, getTsType(type.result), opts);
    case 'RecordType':
      return toRecordTypeString(type);
    default:
      throw new Error('Unexpected type: ' + type.type);
  }
}

function getTypeApplicationString(type) {
    var baseType = getTsType(type.expression, {isChildOfTypeApplication: true});
    if (baseType === 'Object') {
      return getObjectTypeApplicationString(type.applications);
    } else if (isNotTsGenericType(baseType)) {
      return baseType;
    }
    var paramStrList = type.applications.map(function(app) {
      return getTsType(app);
    });
    var paramNum = getTsGenericTypeParamNum(baseType);
    if (paramStrList.length < paramNum) {
      var diff = paramNum - paramStrList.length;
      for (var i = 0; i < diff; i++) {
        paramStrList.push('any');
      }
    }
    return baseType + '<' + paramStrList.join(', ') + '>';
}

function getObjectTypeApplicationString(applications) {
    var indexType = 'string';
    var valueType;
    if (applications.length === 1) {
        valueType = getTsType(applications[0]);
    } else if (applications.length === 2) {
        indexType = getTsType(applications[0]);
        valueType = getTsType(applications[1]);
    } else {
        throw new Error('Object cannot accept type application lenght: ' + applications.length);
    }

    if (indexType !== 'string' && indexType !== 'number') {
        indexType = 'string';
    }
    return '{[index: ' + indexType + ']: ' + valueType + '}';
}

function isNotTsGenericType(name) {
  var nonGenericTypes = {
    'Object': true,
    // TODO: Iterator and ArrayLike has a type parameter implicitly.
    'goog.iter.Iterable': true,
    'goog.array.ArrayLike': true
  };
  return (name in nonGenericTypes);
}

function getTsGenericTypeParamNum(name) {
  var genericTypes = {
    'Array': 1,
    'Map': 2,
    'NodeListOf': 1,
    'Set': 1,
    'WeakMap': 2,
    'Thenable': 1,
    'goog.Promise': 2,
    'goog.Thenable': 1,
    'goog.async.Deferred': 1,
    'goog.events.EventHandler': 1,
    'goog.events.EventId': 1,
    'goog.iter.Iterator': 1,
    'goog.structs.Heap': 2,
    'goog.structs.Map': 2,
    'goog.structs.Pool': 1,
    'goog.structs.PriorityPool': 1,
    'goog.structs.Set': 1,
    'goog.structs.TreeNode': 2
  };
  return genericTypes[name];
}

function getArgName(name, type) {
  if (isReservedWord(name)) {
    name += '_';
  }

  if (!type) {
    return name;
  }

  switch (type.type) {
    case 'OptionalType':
      return name + '?';
    case 'RestType':
      return '...' + name;
    default:
      return name;
  }
}

function isReservedWord(name) {
  return name === 'class';
}

function getFunctionAnnotation(tags, opt_ignoreReturn, opt_ignoreTemplate) {
  var params = [];
  var returns = null;

  tags.forEach(function(tag) {
    switch (tag.title) {
      case 'param':
        params.push({type: getTsType(tag.type), name: getArgName(tag.name, tag.type)});
        break;
      case 'return':
        if (!opt_ignoreReturn) {
          returns = getTsType(tag.type);
        }
        break;
      default:
        break;
    }
  });

  returns = returns || 'void';
  var args = toFunctionArgsString(params);
  if (opt_ignoreReturn) {
    return args;
  }
  return args + ': ' + returns;
}

function getTemplates(tags) {
  var templates = [];
  tags.some(function(tag) {
    if (tag.title === 'template') {
      templates = tag.description.split(',').map(function(t) {return t.trim();});
      return true;
    }
  });
  return templates;
}

function getClassConstructorAnnotation(tags) {
  return getFunctionAnnotation(tags, true, true);
}

function getParentClasses(tags) {
  return tags.filter(function(tag) {
    return tag.title === 'extends';
  }).map(function(tag) {
    return getTsType(tag.type);
  });
}

function getTypeAnnotation(tags, statement) {
  var type = {
    enum: null,
    type: null
  };

  tags.forEach(function(tag) {
    switch (tag.title) {
      case 'enum':
        type.enum = {type: getTsType(tag.type)};
        break;
      case 'type':
        type.type = {type: getTsType(tag.type)};
        break;
    }
  });

  if (type.type) {
    return type.type.type;
  } else if (isAssignement(statement)) {
    return 'any';
  } else {
    console.error(tags);
    throw new Error('Unsupported type annotations.');
  }
}

function toRecordTypeString(tag) {
  return '{' + tag.fields.map(function(field) {
    return field.key + ': ' + getTsType(field.value);
  }).join('; ') + '}';
}

function toFunctionTypeString(params, ret, opts) {
  opts = opts || {};
  var args = toFunctionArgsString(params);
  var returns = ret ? ret : 'void';
  var str = args + ' => ' + returns;
  if (opts.isUnionTypeMember) {
    str = '(' + str + ')';
  }
  return str;
}

function toFunctionArgsString(params) {
  return '(' + params.map(function(param) {
    return param.name + ': ' + param.type;
  }).join(', ') + ')';
}

function isAssignement(statement) {
  return statement.type === Syntax.ExpressionStatement &&
    statement.expression.type === Syntax.AssignmentExpression;
}

function isFunctionDeclaration(statement, tags) {
  var isFunction = tags.some(function(tag) {
    return tag.title === 'param' || tag.title === 'return';
  });

  if (isFunction) {
    return true;
  }

  if (isAssignement(statement)) {
    if (statement.expression.right.type === Syntax.FunctionExpression) {
      return true;
    } else if (statement.expression.right.type === Syntax.MemberExpression) {
      var right = getMemberExpressionNameList(statement.expression.right).join('.');
      switch (right) {
        case 'goog.abstractMethod':
        case 'goog.nullFunction':
        case 'goog.functions.TRUE':
        case 'goog.functions.FALSE':
        case 'goog.functions.NULL':
          return true;
        default:
          // ignore
      }
    }
    return false;
  }

  var isNotFunction = tags.some(function(tag) {
    switch (tag.title) {
      case 'const':
      case 'constructor':
      case 'define':
      case 'dict':
      case 'enum':
      case 'extends':
      case 'implements':
      case 'interface':
      case 'struct':
      case 'type':
      case 'typedef':
        return true;
      default:
        return false;
    }
  });
  return !isNotFunction;
}

function isClassDeclaration(statement, tags) {
  return tags.some(function(tag) {
    return tag.title === 'constructor';
  });
}

function isInterfaceDeclaration(statement, tags) {
  return tags.some(function(tag) {
    return tag.title === 'interface';
  });
}

function getFullName(statement) {
  switch (statement.type) {
    case Syntax.ExpressionStatement:
      return getFullNameFromExpressionStatement(statement);
    case Syntax.FunctionDeclaration:
      // function declarations should not be exported.
      return null;
    case Syntax.VariableDeclaration:
      return getFullNameFromVariableDeclaration(statement);
    default:
      throw new Error('Unexpected statement');
  }
}

function getFullNameFromVariableDeclaration(statement) {
  // No variable declarations in Closure Library
  return null;
}

/**
 * @param {Object} statement
 * @return {Array.<string>|null}
 */
function getFullNameFromExpressionStatement(statement) {
  var expression = statement.expression;
  var targetExpression;
  switch (expression.type) {
    case Syntax.AssignmentExpression:
      targetExpression = expression.left;
      break;
    case Syntax.MemberExpression:
      targetExpression = expression;
      break;
    case Syntax.CallExpression:
      // Like: @fileoverview => goog.provide('foo')
      return null;
    default:
      console.error(statement);
      throw new Error('Unexpected expression: ' + expression.type);
  }

  return getMemberExpressionNameList(targetExpression);
}

/**
 * @param {Object} expression
 * @return {Array.<string>|null} null if the expression includes a literal.
 */
function getMemberExpressionNameList(expression) {
  var fullname = [];
  estraverse.traverse(expression, {
    enter: function(node, parent) {
      if (node.computed || node.type === Syntax.Literal) {
        fullname = null;
        this.break();
      }
    },
    leave: function(node, parent) {
      if (node.type === Syntax.Identifier) {
        fullname.push(node.name);
      }
    }
  });
  return fullname;
}

function replaceTypeName(name) {
  var map = {
    EventTarget: 'goog.globalEventTarget'
  };
  if (name in map) {
    return map[name];
  } else {
    return name;
  }
}

module.exports = {
  generate: generate
};
