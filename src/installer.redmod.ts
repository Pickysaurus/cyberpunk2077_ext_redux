import path from "path";
import {
  flow,
  pipe,
} from "fp-ts/lib/function";
import { not } from "fp-ts/lib/Predicate";
import {
  map,
  filter,
  flatten,
  some as any,
  toArray as toMutableArray,
  findFirstMap,
} from "fp-ts/ReadonlyArray";
import {
  TaskEither,
  chainEitherKW,
  map as mapTE,
  mapLeft as mapLeftTE,
  fromOption as fromOptionTE,
  chain,
  traverseArray as traverseArrayTE,
  chainEitherK,
} from "fp-ts/lib/TaskEither";
import * as J from "fp-ts/lib/Json";
import {
  Either,
  isLeft,
  left,
  right,
  chain as chainE,
  map as mapE,
  traverseArray as traverseArrayE,
} from "fp-ts/lib/Either";
import {
  none,
  some,
  Option,
} from "fp-ts/lib/Option";
import {
  FileTree,
  findDirectSubdirsWithSome,
  filesUnder,
  Glob,
  FILETREE_ROOT,
  sourcePaths,
  subdirNamesIn,
  subdirsIn,
  pathEq,
  pathIn,
  dirWithSomeIn,
  dirInTree,
  filesIn,
} from "./filetree";
import {
  REDMOD_INFO_FILENAME,
  REDMOD_BASEDIR,
  REDMOD_SUBTYPE_DIRNAMES,
  REDmodInfo,
  decodeREDmodInfo,
  REDMOD_ARCHIVES_DIRNAME,
  REDMOD_CUSTOMSOUNDS_DIRNAME,
  REDMOD_TWEAKS_DIRNAME,
  REDMOD_TWEAKS_VALID_SUBDIR,
  REDMOD_ARCHIVES_VALID_EXTENSIONS,
  REDMOD_CUSTOMSOUNDS_VALID_EXTENSIONS,
  REDMOD_SCRIPTS_VALID_EXTENSIONS,
  REDMOD_TWEAKS_VALID_EXTENSIONS,
  REDMOD_SCRIPTS_DIRNAME,
  REDMOD_SCRIPTS_VALID_SUBDIR_NAMES,
} from "./installers.layouts";
import {
  fileFromDiskTE,
  instructionsForSourceToDestPairs,
  moveFromTo,
} from "./installers.shared";
import {
  VortexApi,
  VortexTestResult,
  VortexInstallResult,
  VortexInstruction,
} from "./vortex-wrapper";
import {
  InstallerType,
  ModInfo,
  V2077InstallFunc,
  V2077TestFunc,
} from "./installers.types";
import { showWarningForUnrecoverableStructureError } from "./ui.dialogs";
import { Features } from "./features";

//
// Types
//


interface REDmodInfoAndPathDetes {
  redmodInfo: REDmodInfo;
  relativeSourceDir: string;
  relativeDestDir: string;
  fileTree: FileTree;
}


//
// Helpers
//

const tryReadInfoJson = (
  installingDir: string,
  relativeREDmodDir: string,
): TaskEither<Error, REDmodInfo> =>
  pipe(
    fileFromDiskTE(
      path.join(installingDir, relativeREDmodDir, REDMOD_INFO_FILENAME),
      path.join(relativeREDmodDir, REDMOD_INFO_FILENAME),
    ),
    chainEitherKW((file) =>
      pipe(
        file.content,
        J.parse,
        chainE(decodeREDmodInfo),
      )),
    mapLeftTE((err) => new Error(`Error validating ${path.join(relativeREDmodDir, REDMOD_INFO_FILENAME)}: ${err}`)),
  );

const validateDeclaredModnameMatchesDir =
  (infoAndPath: REDmodInfoAndPathDetes): Either<Error, REDmodInfoAndPathDetes> => {
    const dirname = path.basename(infoAndPath.relativeSourceDir);

    // Don't like this even though it's correct.
    // We probably need to carry the layout type.
    const hasMatchingNameOrItsToplevel =
      infoAndPath.relativeSourceDir === `` ||
      pathEq(dirname)(infoAndPath.redmodInfo.name);

    return hasMatchingNameOrItsToplevel
      ? right(infoAndPath)
      : left(new Error(`REDmod directory '${dirname}' does not match mod name '${infoAndPath.redmodInfo.name}' in ${REDMOD_INFO_FILENAME}`));
  };

const instructionsToMoveAllFromSourceToDestination = (
  sourceDirPrefix: string,
  destinationDirPrefix: string,
  files: readonly string[],
): readonly VortexInstruction[] =>
  pipe(
    files,
    map(moveFromTo(sourceDirPrefix, destinationDirPrefix)),
    instructionsForSourceToDestPairs,
  );


//
// REDmod
//

const matchREDmodInfoJson = (p: string): boolean =>
  pathEq(REDMOD_INFO_FILENAME)(path.basename(p));

const matchREDmodArchive = (p: string): boolean =>
  pathIn(REDMOD_ARCHIVES_VALID_EXTENSIONS)(path.extname(p));

const matchREDmodCustomSound = (p: string): boolean =>
  pathIn(REDMOD_CUSTOMSOUNDS_VALID_EXTENSIONS)(path.extname(p));

const matchREDmodScript = (p: string): boolean =>
  pathIn(REDMOD_SCRIPTS_VALID_EXTENSIONS)(path.extname(p));

const matchREDmodTweak = (p: string): boolean =>
  pathIn(REDMOD_TWEAKS_VALID_EXTENSIONS)(path.extname(p));


const matchAnyREDmodSubtypeDir = (fileTree: FileTree) =>
  (inDir: string): boolean =>
    pipe(
      subdirNamesIn(inDir, fileTree),
      any(pathIn(REDMOD_SUBTYPE_DIRNAMES)),
    );

const findCanonicalREDmodDirs = (fileTree: FileTree): readonly string[] =>
  pipe(
    findDirectSubdirsWithSome(REDMOD_BASEDIR, matchREDmodInfoJson, fileTree),
    filter(matchAnyREDmodSubtypeDir(fileTree)),
  );

const findNamedREDmodDirs = (fileTree: FileTree): readonly string[] =>
  pipe(
    findDirectSubdirsWithSome(FILETREE_ROOT, matchREDmodInfoJson, fileTree),
    filter(matchAnyREDmodSubtypeDir(fileTree)),
  );

const detectCanonREDmodLayout = (fileTree: FileTree): boolean =>
  dirInTree(REDMOD_BASEDIR, fileTree);

const detectNamedREDmodLayout = (fileTree: FileTree): boolean =>
  findNamedREDmodDirs(fileTree).length > 0;

const detectToplevelREDmodLayout = (fileTree: FileTree): boolean =>
  dirWithSomeIn(FILETREE_ROOT, matchREDmodInfoJson, fileTree) &&
  matchAnyREDmodSubtypeDir(fileTree)(FILETREE_ROOT);

export const detectREDmodLayout = (fileTree: FileTree): boolean =>
  detectCanonREDmodLayout(fileTree) ||
  detectNamedREDmodLayout(fileTree) ||
  detectToplevelREDmodLayout(fileTree);

//
// Layouts
//

const splitCanonREDmodsIfTheresMultiple = (fileTree: FileTree): Either<Error, readonly string[]> => {
  const allValidCanonicalREDmodDirs = findCanonicalREDmodDirs(fileTree);
  const allREDmodLookingDirs = subdirsIn(REDMOD_BASEDIR, fileTree);

  const invalidDirs = pipe(
    allREDmodLookingDirs,
    filter(not(pathIn(allValidCanonicalREDmodDirs))),
  );

  if (invalidDirs.length > 0) {
    return left(new Error(`${InstallerType.REDmod}: Canon Layout: these directories don't look like valid REDmods: ${invalidDirs.join(`, `)}`));
  }

  return right(allValidCanonicalREDmodDirs);
};

// Why is this not validating the same way??
const splitNamedREDmodsIfTheresMultiple = (fileTree: FileTree): Either<Error, readonly string[]> =>
  right(findNamedREDmodDirs(fileTree));

const collectPathDetesForInstructions = (
  relativeSourceDir: string,
  redmodInfo: REDmodInfo,
  fileTree: FileTree,
): Either<Error, REDmodInfoAndPathDetes> =>
  right({
    redmodInfo,
    relativeSourceDir,
    relativeDestDir: path.join(REDMOD_BASEDIR, redmodInfo.name),
    fileTree,
  });


const returnInstructionsAndLogEtc = (
  _api: VortexApi,
  _fileTree: FileTree,
  _modInfo: ModInfo,
  _features: Features,
  instructions: readonly VortexInstruction[],
): Promise<VortexInstallResult> =>
  Promise.resolve({ instructions: toMutableArray(instructions) });


const failAfterWarningUserAndLogging = (
  api: VortexApi,
  fileTree: FileTree,
  modInfo: ModInfo,
  features: Features,
  error: Error,
): Promise<VortexInstallResult> => {
  const errorMessage = `Didn't Find Expected REDmod Installation!`;

  api.log(
    `error`,
    `${InstallerType.REDmod}: ${errorMessage} Error: ${error.message}`,
    sourcePaths(fileTree),
  );

  showWarningForUnrecoverableStructureError(
    api,
    InstallerType.REDmod,
    errorMessage,
    sourcePaths(fileTree),
  );

  return Promise.reject(new Error(errorMessage));
};

//
// Layouts for REDmod subtypes
//

const initJsonLayoutAndValidation = (
  api: VortexApi,
  infoAndPaths: REDmodInfoAndPathDetes,
): Either<Error, readonly VortexInstruction[]> =>
  pipe(
    validateDeclaredModnameMatchesDir(infoAndPaths),
    mapE(({ relativeSourceDir, relativeDestDir }) =>
      instructionsToMoveAllFromSourceToDestination(
        relativeSourceDir,
        relativeDestDir,
        [path.join(relativeSourceDir, REDMOD_INFO_FILENAME)],
      )),
  );


const archiveLayoutAndValidation = (
  _api: VortexApi,
  {
    relativeSourceDir,
    relativeDestDir,
    fileTree,
  }: REDmodInfoAndPathDetes,
): Either<Error, readonly VortexInstruction[]> => {
  const archiveDir =
    path.join(relativeSourceDir, REDMOD_ARCHIVES_DIRNAME);

  const allArchiveFilesForMod =
    filesUnder(archiveDir, matchREDmodArchive, fileTree);

  const instructions = instructionsToMoveAllFromSourceToDestination(
    relativeSourceDir,
    relativeDestDir,
    allArchiveFilesForMod,
  );

  return right(instructions);
};


const customSoundLayoutAndValidation = (
  _api: VortexApi,
  {
    relativeSourceDir,
    relativeDestDir,
    fileTree,
    redmodInfo,
  }: REDmodInfoAndPathDetes,
): Either<Error, readonly VortexInstruction[]> => {
  const customSoundsDir =
    path.join(relativeSourceDir, REDMOD_CUSTOMSOUNDS_DIRNAME);

  const allCustomSoundFiles =
    filesUnder(customSoundsDir, matchREDmodCustomSound, fileTree);

  const soundFilesRequiredPresent = pipe(
    redmodInfo.customSounds || [],
    any((soundDecl) => soundDecl.type !== `mod_skip`),
  );

  const hasSoundFiles =
    allCustomSoundFiles.length > 0;

  // This isn't /exactly/ an exhaustive check...
  if ((soundFilesRequiredPresent && !hasSoundFiles) ||
      (!soundFilesRequiredPresent && hasSoundFiles)) {
    return left(new Error(`Custom Sound sublayout: there are sound files but ${REDMOD_INFO_FILENAME} doesn't declare customSounds!`));
  }

  const instructions = instructionsToMoveAllFromSourceToDestination(
    relativeSourceDir,
    relativeDestDir,
    allCustomSoundFiles,
  );

  return right(instructions);
};


const scriptLayoutAndValidation = (
  _api: VortexApi,
  {
    relativeSourceDir,
    relativeDestDir,
    fileTree,
  }: REDmodInfoAndPathDetes,
): Either<Error, readonly VortexInstruction[]> => {
  const scriptsDir =
    path.join(relativeSourceDir, REDMOD_SCRIPTS_DIRNAME);

  const allScriptFiles =
    filesUnder(scriptsDir, matchREDmodScript, fileTree);

  const allScriptFilesInValidBasedir = pipe(
    REDMOD_SCRIPTS_VALID_SUBDIR_NAMES,
    map((validScriptSubdir) => filesUnder(path.join(scriptsDir, validScriptSubdir), matchREDmodScript, fileTree)),
    flatten,
  );

  if (allScriptFiles.length !== allScriptFilesInValidBasedir.length) {
    const invalidScriptFiles = pipe(
      allScriptFiles,
      filter(not(pathIn(allScriptFilesInValidBasedir))),
    );

    return left(new Error(`Script sublayout: these files don't look like valid REDmod tweaks: ${invalidScriptFiles.join(`, `)}`));
  }

  const instructions = instructionsToMoveAllFromSourceToDestination(
    relativeSourceDir,
    relativeDestDir,
    allScriptFiles,
  );

  return right(instructions);
};


const tweakLayoutAndValidation = (
  _api: VortexApi,
  {
    relativeSourceDir,
    relativeDestDir,
    fileTree,
  }: REDmodInfoAndPathDetes,
): Either<Error, readonly VortexInstruction[]> => {
  const tweaksDir =
    path.join(relativeSourceDir, REDMOD_TWEAKS_DIRNAME);

  const tweaksDirWithValidBasedir =
    path.join(tweaksDir, REDMOD_TWEAKS_VALID_SUBDIR);

  const allTweakFiles =
    filesUnder(tweaksDir, matchREDmodTweak, fileTree);

  const allTweakFilesInValidBasedir =
    filesUnder(tweaksDirWithValidBasedir, matchREDmodTweak, fileTree);

  if (allTweakFiles.length !== allTweakFilesInValidBasedir.length) {
    const invalidTweakFiles = pipe(
      allTweakFiles,
      filter(not(pathIn(allTweakFilesInValidBasedir))),
    );

    return left(new Error(`Tweak Layout: these files don't look like valid REDmod tweaks: ${invalidTweakFiles.join(`, `)}`));
  }

  const instructions = instructionsToMoveAllFromSourceToDestination(
    relativeSourceDir,
    relativeDestDir,
    allTweakFiles,
  );

  return right(instructions);
};


const extraFilesLayoutAndValidation = (
  api: VortexApi,
  {
    relativeSourceDir,
    relativeDestDir,
    fileTree,
  }: REDmodInfoAndPathDetes,
): Either<Error, readonly VortexInstruction[]> => {
  const filesInSubdirsNotHandled = pipe(
    subdirNamesIn(relativeSourceDir, fileTree),
    filter(not(pathIn(REDMOD_SUBTYPE_DIRNAMES))),
    map((subdir) => filesUnder(path.join(relativeSourceDir, subdir), Glob.Any, fileTree)),
    flatten,
  );

  const allRemainingFiles = [
    ...filesIn(relativeSourceDir, not(matchREDmodInfoJson), fileTree),
    ...filesInSubdirsNotHandled,
  ];

  api.log(`warn`, `Found some extra files in mod root, installing them too:`, allRemainingFiles);

  const instructions = instructionsToMoveAllFromSourceToDestination(
    relativeSourceDir,
    relativeDestDir,
    allRemainingFiles,
  );

  return right(instructions);
};

//
// Vortex
//

//
// testSupported
//

export const testForREDmod: V2077TestFunc = (
  _api: VortexApi,
  fileTree: FileTree,
): Promise<VortexTestResult> => Promise.resolve({
  supported: detectREDmodLayout(fileTree),
  requiredFiles: [],
});

//
// install
//

const knownError = (message: string) => (): Error => new Error(`${InstallerType.REDmod}: ${message}`);

type ModDirsForLayoutFunc = (FileTree) => Either<Error, readonly string[]>;

const canonLayoutModDirs = flow(splitCanonREDmodsIfTheresMultiple);
const namedLayoutModDirs = flow(splitNamedREDmodsIfTheresMultiple);
const toplevelLayoutDir = (_fileTree: FileTree): Either<Error, readonly string[]> => right([FILETREE_ROOT]);

const canonLayoutMatches = (fileTree: FileTree): Option<ModDirsForLayoutFunc> =>
  (detectCanonREDmodLayout(fileTree)
    ? some(canonLayoutModDirs)
    : none);

const namedLayoutMatches = (fileTree: FileTree): Option<ModDirsForLayoutFunc> =>
  (detectNamedREDmodLayout(fileTree)
    ? some(namedLayoutModDirs)
    : none);

const toplevelLayoutMatches = (fileTree: FileTree): Option<ModDirsForLayoutFunc> =>
  (detectToplevelREDmodLayout(fileTree)
    ? some(toplevelLayoutDir)
    : none);


export const installREDmod: V2077InstallFunc = async (
  api: VortexApi,
  fileTree: FileTree,
  modInfo: ModInfo,
  features: Features,
): Promise<VortexInstallResult> => {
  const singleModPipeline =
    (relativeModDir: string): TaskEither<Error, readonly VortexInstruction[]> =>
      pipe(
        tryReadInfoJson(modInfo.installingDir, relativeModDir),
        chainEitherKW((redmodInfo) => pipe(
          collectPathDetesForInstructions(relativeModDir, redmodInfo, fileTree),
          chainE((modInfoAndPathDetes) => pipe(
            [
              initJsonLayoutAndValidation,
              archiveLayoutAndValidation,
              customSoundLayoutAndValidation,
              scriptLayoutAndValidation,
              tweakLayoutAndValidation,
              extraFilesLayoutAndValidation,
            ],
            traverseArrayE((layout) => layout(api, modInfoAndPathDetes)),
          )),
          mapE(flatten),
        )),
      );

  const allModsForLayoutPipeline = pipe(
    [
      canonLayoutMatches,
      namedLayoutMatches,
      toplevelLayoutMatches,
    ],
    findFirstMap((allModDirsForLayoutIfMatch) => allModDirsForLayoutIfMatch(fileTree)),
    fromOptionTE(knownError(`No REDmod layout found! This shouldn't happen, we already tested we should handle this!`)),
    chainEitherK((allModDirsForLayout) => allModDirsForLayout(fileTree)),
    chain(flow(
      traverseArrayTE(singleModPipeline),
      mapTE(flatten),
    )),
  );

  // At this point we have to break out to interop with the rest..
  const allInstructionsForEverySubmodInside = await allModsForLayoutPipeline();

  return isLeft(allInstructionsForEverySubmodInside)
    ? failAfterWarningUserAndLogging(api, fileTree, modInfo, features, allInstructionsForEverySubmodInside.left)
    : returnInstructionsAndLogEtc(api, fileTree, modInfo, features, allInstructionsForEverySubmodInside.right);
};
